# Trusted single-machine/container-internal service: no request authentication, credentials travel over plaintext internal HTTP, never expose publicly.
import base64
import datetime
import decimal
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

MAX_BODY_BYTES = 20 * 1024 * 1024
LOG_TAIL_CHARS = 8000
BUILD_TIMEOUT_SECONDS = 180
DEFAULT_MAX_ROWS = 500
MAX_ROWS = 10_000
MAX_COLUMNS = 200
MAX_REFLECT_TABLES = 200
SECRET_KEY_HINTS = (
    "password",
    "secret",
    "token",
    "credential",
    "connection_url",
    "connectionurl",
    "dsn",
    "access_key",
    "private_key",
)

logger = None
with suppress(Exception):
    from loguru import logger

    logger.remove()
    logger.add(sys.stderr, level="WARNING")


def _collect_secrets(value, key=""):
    if isinstance(value, dict):
        return [s for k, v in value.items() for s in _collect_secrets(v, k)]
    if isinstance(value, list):
        return [s for v in value for s in _collect_secrets(v, key)]
    if isinstance(value, str) and any(hint in key.lower() for hint in SECRET_KEY_HINTS):
        secrets = [value]
        if key.lower() in ("connection_url", "connectionurl", "dsn"):
            with suppress(ValueError):
                parsed_password = urlsplit(value).password
                if parsed_password:
                    secrets.append(parsed_password)
                    decoded_password = unquote(parsed_password)
                    if decoded_password != parsed_password:
                        secrets.append(decoded_password)
        return secrets
    return []


def _hex_ci(byte):
    return "".join(
        digit if digit.isdigit() else f"[{digit.lower()}{digit}]"
        for digit in f"{byte:02X}"
    )


def _percent_pattern(secret):
    parts = []
    for char in secret:
        percent = "".join(f"%{_hex_ci(byte)}" for byte in char.encode("utf-8"))
        parts.append(f"(?:{percent}|{re.escape(char)})")
    return re.compile("".join(parts))


def _escaped_variants(secret):
    bases = {
        secret,
        json.dumps(secret)[1:-1],
        json.dumps(secret, ensure_ascii=False)[1:-1],
        repr(secret)[1:-1],
    }
    variants = set()
    for base in bases:
        variants.add(base)
        variants.add(base.replace("/", "\\/"))
    return sorted((variant for variant in variants if variant), key=len, reverse=True)


def _scrub(text, value):
    secrets = [secret for secret in set(_collect_secrets(value)) if secret]
    for secret in sorted(secrets, key=len, reverse=True):
        for variant in _escaped_variants(secret):
            text = text.replace(variant, "******")
        text = _percent_pattern(secret).sub("******", text)
    return text


def _validation_error_text(exc, connection):
    try:
        errors = exc.errors(include_input=False, include_url=False)
    except TypeError:
        errors = exc.errors()
    parts = [
        f"{'.'.join(str(part) for part in err.get('loc', ())) or '<root>'}: {err.get('type', 'invalid')}"
        for err in errors
    ]
    return _scrub("; ".join(parts), connection)[:2000] or "connection validation failed"


def _log_exception(exc, value):
    if logger is None:
        return
    with suppress(Exception):
        logger.warning(_scrub(f"{type(exc).__name__}: {exc}", value)[:4000])


def _write_file(root, rel, content):
    if not isinstance(rel, str) or not isinstance(content, str):
        raise ValueError("projectFiles must map relative paths to text")
    if not rel or "\x00" in rel or "\\" in rel:
        raise ValueError(f"invalid project path: {rel!r}")
    path = PurePosixPath(rel)
    if path.is_absolute() or any(part in ("..", ".", "") for part in path.parts):
        raise ValueError(f"invalid project path: {rel!r}")
    if path.name in (".env", "profiles.yml"):
        raise ValueError(f"credential files are not accepted: {rel!r}")
    dest = root.joinpath(*path.parts).resolve()
    if not dest.is_relative_to(root):
        raise ValueError(f"invalid project path: {rel!r}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding="utf-8")


def _cli_command():
    wren = shutil.which("wren")
    return [wren] if wren else [sys.executable, "-m", "wren.cli"]


def _last_error(log):
    lines = [line.strip() for line in log.splitlines() if line.strip()]
    return lines[-1][:2000] if lines else ""


def _health():
    try:
        installed = version("wrenai")
    except Exception:
        installed = "unknown"
    return {"ok": True, "wrenai": installed}


def _test_connection(payload):
    datasource = payload.get("datasource")
    connection = payload.get("connection")
    if not isinstance(datasource, str) or not isinstance(connection, dict):
        return {"ok": False, "error": "datasource must be a string and connection must be an object"}

    connector = None
    try:
        from pydantic import ValidationError
        from wren.connector.factory import get_connector
        from wren.model.data_source import DataSource

        try:
            source = DataSource(datasource)
            connector = get_connector(source, source.get_connection_info(connection))
            connector.query("SELECT 1")
            return {"ok": True}
        except ValidationError as exc:
            return {"ok": False, "error": _validation_error_text(exc, connection)}
    except Exception as exc:
        _log_exception(exc, connection)
        return {"ok": False, "error": f"{type(exc).__name__}: database connection failed"}
    finally:
        if connector is not None:
            with suppress(Exception):
                connector.close()


def _run_context_build(root, datasource, connection):
    try:
        proc = subprocess.run(
            [*_cli_command(), "context", "build", "--path", str(root)],
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT_SECONDS,
            cwd=str(Path(__file__).resolve().parent),
        )
    except subprocess.TimeoutExpired:
        return "", False, None, f"build timed out after {BUILD_TIMEOUT_SECONDS}s"

    scrubbed = _scrub(proc.stdout + proc.stderr, connection)
    log_truncated = len(scrubbed) > LOG_TAIL_CHARS
    log = scrubbed[-LOG_TAIL_CHARS:]
    if proc.returncode != 0:
        return (
            log,
            log_truncated,
            None,
            _last_error(log) or f"build exited with code {proc.returncode}",
        )

    manifest_path = root / "target" / "mdl.json"
    if not manifest_path.is_file():
        return log, log_truncated, None, "build produced no target/mdl.json"

    manifest = manifest_path.read_text(encoding="utf-8")
    try:
        manifest_data = json.loads(manifest)
    except json.JSONDecodeError:
        return log, log_truncated, None, "generated mdl.json is not valid JSON"

    if manifest_data.get("dataSource") != datasource:
        return log, log_truncated, None, "built MDL dataSource does not match requested datasource"

    return log, log_truncated, manifest, None


def _build(payload):
    datasource = payload.get("datasource")
    connection = payload.get("connection")
    if not isinstance(datasource, str) or not isinstance(connection, dict):
        return {
            "ok": False,
            "log": "",
            "logTruncated": False,
            "error": "datasource must be a string and connection must be an object",
        }
    project_files = payload.get("projectFiles")
    if not isinstance(project_files, dict) or not project_files:
        return {
            "ok": False,
            "log": "",
            "logTruncated": False,
            "error": "projectFiles must be a non-empty object",
        }

    with tempfile.TemporaryDirectory(prefix="wren-build-") as tmp:
        root = Path(tmp).resolve()
        try:
            for rel, content in project_files.items():
                _write_file(root, rel, content)
        except (ValueError, OSError) as exc:
            return {
                "ok": False,
                "log": "",
                "logTruncated": False,
                "error": _scrub(str(exc), connection),
            }

        log, log_truncated, manifest, error = _run_context_build(root, datasource, connection)
        if error is not None:
            return {
                "ok": False,
                "log": log,
                "logTruncated": log_truncated,
                "error": error,
            }

        return {
            "ok": True,
            "mdlManifest": manifest,
            "log": log,
            "logTruncated": log_truncated,
        }


def _model_path(table):
    if (
        not isinstance(table, str)
        or not table
        or table in (".", "..")
        or ".." in table
        or "/" in table
        or "\\" in table
        or "\x00" in table
    ):
        raise ValueError(f"unsupported table name for model generation: {table!r}")
    return f"models/{table}/metadata.yml"


def _generate_mdl(payload):
    datasource = payload.get("datasource")
    connection = payload.get("connection")
    if not isinstance(datasource, str) or not isinstance(connection, dict):
        return {
            "ok": False,
            "log": "",
            "logTruncated": False,
            "error": "datasource must be a string and connection must be an object",
        }

    connector = None
    try:
        from pydantic import ValidationError
        from wren.connector.factory import get_connector
        from wren.model.data_source import DataSource

        try:
            source = DataSource(datasource)
            connector = get_connector(source, source.get_connection_info(connection))
        except ValidationError as exc:
            return {
                "ok": False,
                "log": "",
                "logTruncated": False,
                "error": _validation_error_text(exc, connection),
            }

        tables = connector.query(
            "select table_catalog, table_schema, table_name from information_schema.tables "
            "where table_schema not in ('information_schema', 'pg_catalog') "
            "order by table_catalog, table_schema, table_name"
        ).to_pylist()
        if len(tables) > MAX_REFLECT_TABLES:
            return {
                "ok": False,
                "log": "",
                "logTruncated": False,
                "error": (
                    f"schema reflection found {len(tables)} tables, "
                    f"exceeding the limit of {MAX_REFLECT_TABLES}"
                ),
            }

        columns_by_table = {}
        for column in connector.query(
            "select table_catalog, table_schema, table_name, column_name, data_type, is_nullable "
            "from information_schema.columns "
            "where table_schema not in ('information_schema', 'pg_catalog') "
            "order by table_catalog, table_schema, table_name, ordinal_position"
        ).to_pylist():
            key = (
                column["table_catalog"],
                column["table_schema"],
                column["table_name"],
            )
            columns_by_table.setdefault(key, []).append(column)

        project_files = {
            "wren_project.yml": (
                "schema_version: 5\n"
                "name: generated\n"
                'version: "1.0"\n'
                "catalog: wren\n"
                "schema: public\n"
                f"data_source: {datasource}\n"
            ),
            "relationships.yml": "relationships: []\n",
        }
        try:
            for table_row in tables:
                catalog = table_row["table_catalog"]
                schema_name = table_row["table_schema"]
                table = table_row["table_name"]
                path = _model_path(table)
                if path in project_files:
                    raise ValueError(f"duplicate table name across schemas: {table!r}")
                columns = columns_by_table.get((catalog, schema_name, table), [])
                project_files[path] = json.dumps(
                    {
                        "name": table,
                        "table_reference": {
                            "catalog": catalog,
                            "schema": schema_name,
                            "table": table,
                        },
                        "columns": [
                            {
                                "name": column["column_name"],
                                "type": str(column["data_type"]).upper(),
                                "is_calculated": False,
                                "not_null": column["is_nullable"] == "NO",
                                "properties": {},
                            }
                            for column in columns
                        ],
                        "primary_key": None,
                        "cached": False,
                        "properties": {},
                    },
                    ensure_ascii=False,
                )
        except (KeyError, TypeError, ValueError) as exc:
            return {
                "ok": False,
                "log": "",
                "logTruncated": False,
                "error": _scrub(f"schema reflection failed: {exc}", connection)[:2000],
            }

        with tempfile.TemporaryDirectory(prefix="wren-generate-") as tmp:
            root = Path(tmp).resolve()
            try:
                for rel, content in project_files.items():
                    _write_file(root, rel, content)
            except (ValueError, OSError) as exc:
                return {
                    "ok": False,
                    "log": "",
                    "logTruncated": False,
                    "error": _scrub(str(exc), connection)[:2000],
                }

            log, log_truncated, manifest, error = _run_context_build(
                root, datasource, connection
            )
            if error is not None:
                return {
                    "ok": False,
                    "log": log,
                    "logTruncated": log_truncated,
                    "error": error,
                }

            return {
                "ok": True,
                "projectFiles": project_files,
                "mdlManifest": manifest,
                "log": log,
                "logTruncated": log_truncated,
            }
    except Exception as exc:
        _log_exception(exc, connection)
        return {
            "ok": False,
            "log": "",
            "logTruncated": False,
            "error": f"{type(exc).__name__}: schema reflection failed",
        }
    finally:
        if connector is not None:
            with suppress(Exception):
                connector.close()


def _json_value(value):
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time)):
        return value.isoformat()
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return base64.b64encode(value).decode("ascii")
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError):
        return str(value)
    return value


def _query(payload):
    mdl = payload.get("mdlManifest")
    datasource = payload.get("datasource")
    connection = payload.get("connection")
    sql = payload.get("sql")
    properties = payload.get("properties")
    max_rows = payload.get("maxRows")
    if not isinstance(mdl, str) or not mdl:
        return {"ok": False, "error": "mdlManifest must be a non-empty string"}
    if not isinstance(datasource, str) or not datasource:
        return {"ok": False, "error": "datasource must be a non-empty string"}
    if not isinstance(connection, dict):
        return {"ok": False, "error": "connection must be an object"}
    if not isinstance(sql, str) or not sql:
        return {"ok": False, "error": "sql must be a non-empty string"}
    if properties is not None and (
        not isinstance(properties, dict)
        or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in properties.items()
        )
    ):
        return {"ok": False, "error": "properties must map strings to strings"}
    if max_rows is not None and (
        isinstance(max_rows, bool) or not isinstance(max_rows, int) or max_rows < 0
    ):
        return {"ok": False, "error": "maxRows must be a non-negative integer"}
    if max_rows is None:
        max_rows = DEFAULT_MAX_ROWS
    max_rows = min(max_rows, MAX_ROWS)

    engine = None
    try:
        from wren.config import WrenConfig
        from wren.engine import WrenEngine

        engine = WrenEngine(
            base64.b64encode(mdl.encode("utf-8")).decode("ascii"),
            datasource,
            connection,
            fallback=False,
            config=WrenConfig(strict_mode=True),
        )
        table = engine.query(sql, limit=max_rows + 1, properties=properties, read_only=True)
        columns = list(table.schema.names)
        if len(columns) > MAX_COLUMNS:
            return {"ok": False, "error": "结果列过多"}
        rows = [
            [_json_value(row.get(column)) for column in columns]
            for row in table.to_pylist()
        ]
        truncated = len(rows) > max_rows
        if truncated:
            rows = rows[:max_rows]
        return {
            "ok": True,
            "columns": columns,
            "rows": rows,
            "rowCount": len(rows),
            "truncated": truncated,
        }
    except Exception as exc:
        code = getattr(exc, "error_code", None)
        if code is not None:
            message = getattr(exc, "message", None) or str(exc)
            phase = getattr(exc, "phase", None)
            return {
                "ok": False,
                "error": _scrub(message, connection)[:2000],
                "code": getattr(code, "name", str(code)),
                "phase": getattr(phase, "name", None),
            }
        _log_exception(exc, connection)
        return {"ok": False, "error": "query failed"}
    finally:
        if engine is not None:
            with suppress(Exception):
                engine.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "wren-runtime"
    sys_version = ""

    def log_message(self, fmt, *args):
        sys.stderr.write(
            f"{self.address_string()} {self.command} {self.path.split('?', 1)[0]}\n"
        )

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None, "missing Content-Length"
        try:
            length = int(raw_length)
        except ValueError:
            return None, "invalid Content-Length"
        if length < 0 or length > MAX_BODY_BYTES:
            return None, "request body too large"
        try:
            return json.loads(self.rfile.read(length)), None
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, "invalid JSON"

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/health":
            return self._send(200, _health())
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        routes = {
            "/test-connection": _test_connection,
            "/build": _build,
            "/query": _query,
            "/generate-mdl": _generate_mdl,
        }
        route = routes.get(self.path.split("?", 1)[0])
        if route is None:
            return self._send(404, {"ok": False, "error": "not found"})

        with_log = route is _build or route is _generate_mdl
        payload, error = self._read_json()
        if error is not None:
            result = {"ok": False, "error": error}
            if with_log:
                result["log"] = ""
                result["logTruncated"] = False
            return self._send(400, result)
        if not isinstance(payload, dict):
            result = {"ok": False, "error": "body must be a JSON object"}
            if with_log:
                result["log"] = ""
                result["logTruncated"] = False
            return self._send(400, result)

        try:
            result = route(payload)
        except Exception as exc:
            _log_exception(exc, payload)
            result = {"ok": False, "error": "internal error"}
            if with_log:
                result["log"] = ""
                result["logTruncated"] = False
        self._send(200, result)


def main():
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("WREN_RUNTIME_HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
