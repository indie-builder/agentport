export type SourceLanguage = 'json' | 'markdown' | 'text';

export type SourceEditorProps = {
  value: string;
  onChange: (value: string) => void;
  id?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  language?: SourceLanguage | undefined;
  className?: string | undefined;
  onBlur?: (() => void) | undefined;
};
