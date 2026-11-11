import { Plus, Trash2 } from 'lucide-react';
import { RequiredMark } from '../../components/required-mark.js';
import { Button } from '../../components/ui/button.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import {
  newRangeDraft,
  type RangeDraft,
  type RangeKind,
  rangeExternalLabel,
  rangeKindLabel,
  rangeKinds,
  type SourceType,
} from './shared.js';

export function RangeRows({
  type,
  ranges,
  disabled,
  errors,
  onChange,
}: {
  type: SourceType;
  ranges: RangeDraft[];
  disabled: boolean;
  /** 提交后按行显示缺外部 ID / Ref / Seafile 目录根；未提交时不制造噪音。 */
  errors: Array<{ externalId: string | null; ref: string | null; paths: string | null }>;
  onChange: (ranges: RangeDraft[]) => void;
}) {
  const kinds = rangeKinds[type];
  const patch = (index: number, next: Partial<RangeDraft>) =>
    onChange(ranges.map((range, i) => (i === index ? { ...range, ...next } : range)));

  return (
    <div className="flex flex-col gap-2">
      {ranges.map((range, index) => (
        <div
          key={range.clientId}
          className="flex flex-col gap-2 rounded-item border border-line p-2.5"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">范围 {index + 1}</span>
            <Switch
              id={`source-range-${index}-enabled`}
              size="sm"
              checked={range.enabled}
              disabled={disabled}
              aria-label={`启用范围 ${index + 1}`}
              onCheckedChange={(checked) => patch(index, { enabled: checked })}
            />
            <span className="text-xs text-muted-foreground">{range.enabled ? '启用' : '停用'}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label={`删除范围 ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(ranges.filter((_, i) => i !== index))}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {kinds.length > 1 ? (
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`source-range-${index}-kind`}>类型</FieldLabel>
                <Select
                  value={range.kind}
                  disabled={disabled}
                  onValueChange={(next) => {
                    if (next !== null) patch(index, { kind: next as RangeKind });
                  }}
                  items={kinds.map((kind) => ({ value: kind, label: rangeKindLabel[kind] }))}
                >
                  <SelectTrigger id={`source-range-${index}-kind`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {kinds.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {rangeKindLabel[kind]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field className="gap-1.5" data-invalid={errors[index]?.externalId !== null}>
              <FieldLabel htmlFor={`source-range-${index}-external`}>
                {rangeExternalLabel(range.kind)} <RequiredMark />
              </FieldLabel>
              <Input
                id={`source-range-${index}-external`}
                value={range.externalId}
                disabled={disabled}
                aria-invalid={errors[index]?.externalId !== null}
                aria-describedby={
                  errors[index]?.externalId !== null
                    ? `source-range-${index}-external-error`
                    : undefined
                }
                onChange={(event) => patch(index, { externalId: event.target.value })}
                placeholder={
                  range.kind === 'github_repo'
                    ? 'owner/repo'
                    : range.kind === 'nextcloud_path'
                      ? '/培训资料'
                      : undefined
                }
                className="font-mono"
              />
              <FieldError id={`source-range-${index}-external-error`}>
                {errors[index]?.externalId}
              </FieldError>
            </Field>
            {type === 'github' || type === 'gitlab' ? (
              <>
                <Field className="gap-1.5" data-invalid={errors[index]?.ref !== null}>
                  <FieldLabel htmlFor={`source-range-${index}-ref`}>
                    Ref {type === 'gitlab' ? <RequiredMark /> : null}
                  </FieldLabel>
                  <Input
                    id={`source-range-${index}-ref`}
                    value={range.ref ?? ''}
                    disabled={disabled}
                    aria-invalid={errors[index]?.ref !== null}
                    aria-describedby={
                      errors[index]?.ref !== null ? `source-range-${index}-ref-error` : undefined
                    }
                    onChange={(event) => patch(index, { ref: event.target.value.trim() || null })}
                    placeholder={type === 'github' ? '留空使用默认分支' : '例如 main'}
                    className="font-mono"
                  />
                  <FieldError id={`source-range-${index}-ref-error`}>
                    {errors[index]?.ref}
                  </FieldError>
                </Field>
                <Field className="gap-1.5 sm:col-span-2">
                  <FieldLabel htmlFor={`source-range-${index}-paths`}>Paths</FieldLabel>
                  <Input
                    id={`source-range-${index}-paths`}
                    value={range.paths.join(', ')}
                    disabled={disabled}
                    onChange={(event) =>
                      patch(index, {
                        paths: event.target.value
                          .split(',')
                          .map((path) => path.trim())
                          .filter((path) => path !== ''),
                      })
                    }
                    placeholder={
                      type === 'github'
                        ? '用逗号分隔，留空表示仓库全部路径'
                        : '用逗号分隔，留空表示项目全部路径'
                    }
                    className="font-mono"
                  />
                  <FieldDescription>
                    目录或文件前缀；留空读取{type === 'gitlab' ? '整个项目' : '整个仓库'}
                    ；仅同步文本文件。
                  </FieldDescription>
                </Field>
              </>
            ) : null}
            {type === 'seafile' ? (
              <Field className="gap-1.5 sm:col-span-2" data-invalid={errors[index]?.paths !== null}>
                <FieldLabel htmlFor={`source-range-${index}-paths`}>目录根</FieldLabel>
                <Input
                  id={`source-range-${index}-paths`}
                  value={range.paths.join(', ')}
                  disabled={disabled}
                  aria-invalid={errors[index]?.paths !== null}
                  aria-describedby={
                    errors[index]?.paths !== null ? `source-range-${index}-paths-error` : undefined
                  }
                  onChange={(event) =>
                    patch(index, {
                      paths: event.target.value.split(',').map((path) => path.trim()),
                    })
                  }
                  placeholder="/ 表示整个库，或用逗号分隔多个库内相对目录"
                  className="font-mono"
                />
                <FieldDescription>
                  / 表示整个库；子目录按库内相对路径填写，例如 /Documents。
                </FieldDescription>
                <FieldError id={`source-range-${index}-paths-error`}>
                  {errors[index]?.paths}
                </FieldError>
              </Field>
            ) : null}
          </div>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...ranges, newRangeDraft(kinds[0] as RangeKind)])}
        >
          <Plus data-icon="inline-start" aria-hidden="true" /> 添加范围
        </Button>
      </div>
    </div>
  );
}
