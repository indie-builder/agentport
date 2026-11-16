# Trusted single-machine/container-internal service: no request authentication, credentials travel over plaintext internal HTTP, never expose publicly.
import json
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

        try:
            proc = subprocess.run(
                [*_cli_command(), "context", "build", "--path", str(root)],
                capture_output=True,
                text=True,
                timeout=BUILD_TIMEOUT_SECONDS,
                cwd=str(Path(__file__).resolve().parent),
            )
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "log": "",
                "logTruncated": False,
                "error": f"build timed out after {BUILD_TIMEOUT_SECONDS}s",
            }

        scrubbed = _scrub(proc.stdout + proc.stderr, connection)
        log_truncated = len(scrubbed) > LOG_TAIL_CHARS
        log = scrubbed[-LOG_TAIL_CHARS:]
        if proc.returncode != 0:
            return {
                "ok": False,
                "log": log,
                "logTruncated": log_truncated,
                "error": _last_error(log) or f"build exited with code {proc.returncode}",
            }

        manifest_path = root / "target" / "mdl.json"
        if not manifest_path.is_file():
            return {
                "ok": False,
                "log": log,
                "logTruncated": log_truncated,
                "error": "build produced no target/mdl.json",
            }

        manifest = manifest_path.read_text(encoding="utf-8")
        try:
            manifest_data = json.loads(manifest)
        except json.JSONDecodeError:
            return {
                "ok": False,
                "log": log,
                "logTruncated": log_truncated,
                "error": "generated mdl.json is not valid JSON",
            }

        if manifest_data.get("dataSource") != datasource:
            return {
                "ok": False,
                "log": log,
                "logTruncated": log_truncated,
                "error": "built MDL dataSource does not match requested datasource",
            }

        return {
            "ok": True,
            "mdlManifest": manifest,
            "log": log,
            "logTruncated": log_truncated,
        }


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
        routes = {"/test-connection": _test_connection, "/build": _build}
        route = routes.get(self.path.split("?", 1)[0])
        if route is None:
            return self._send(404, {"ok": False, "error": "not found"})

        is_build = route is _build
        payload, error = self._read_json()
        if error is not None:
            result = {"ok": False, "error": error}
            if is_build:
                result["log"] = ""
                result["logTruncated"] = False
            return self._send(400, result)
        if not isinstance(payload, dict):
            result = {"ok": False, "error": "body must be a JSON object"}
            if is_build:
                result["log"] = ""
                result["logTruncated"] = False
            return self._send(400, result)

        try:
            result = route(payload)
        except Exception as exc:
            _log_exception(exc, payload)
            result = {"ok": False, "error": "internal error"}
            if is_build:
                result["log"] = ""
                result["logTruncated"] = False
        self._send(200, result)


def main():
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
