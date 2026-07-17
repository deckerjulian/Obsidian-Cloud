import type { EditorView } from '@codemirror/view';
import { Icon } from '../components/Icon';
import { wrapInline, prefixLines, insertBlock, TABLE } from './editorCommands';

export function MarkdownToolbar({
  view,
  mode,
  onToggleMode,
  disabled,
}: {
  view: EditorView | null;
  mode: 'edit' | 'preview';
  onToggleMode: () => void;
  disabled: boolean;
}) {
  const editDisabled = disabled || mode !== 'edit' || !view;
  const run = (fn: (v: EditorView) => void) => () => {
    if (view) fn(view);
  };

  const IconBtn = ({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) => (
    <button
      className="oc-tb-btn"
      title={title}
      disabled={editDisabled}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  );
  const TextBtn = ({ label, title, onClick }: { label: string; title: string; onClick: () => void }) => (
    <button
      className="oc-tb-btn oc-tb-text"
      title={title}
      disabled={editDisabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div className="oc-toolbar">
      <IconBtn icon="bold" title="Bold" onClick={run((v) => wrapInline(v, '**'))} />
      <IconBtn icon="italic" title="Italic" onClick={run((v) => wrapInline(v, '*'))} />
      <IconBtn icon="strikethrough" title="Strikethrough" onClick={run((v) => wrapInline(v, '~~'))} />
      <IconBtn icon="code" title="Inline code" onClick={run((v) => wrapInline(v, '`'))} />
      <span className="oc-tb-sep" />
      <TextBtn label="H1" title="Heading 1" onClick={run((v) => prefixLines(v, '# '))} />
      <TextBtn label="H2" title="Heading 2" onClick={run((v) => prefixLines(v, '## '))} />
      <TextBtn label="H3" title="Heading 3" onClick={run((v) => prefixLines(v, '### '))} />
      <span className="oc-tb-sep" />
      <IconBtn icon="list" title="Bullet list" onClick={run((v) => prefixLines(v, '- '))} />
      <IconBtn icon="listOrdered" title="Numbered list" onClick={run((v) => prefixLines(v, (i) => `${i + 1}. `))} />
      <IconBtn icon="quote" title="Quote" onClick={run((v) => prefixLines(v, '> '))} />
      <IconBtn icon="link" title="Link" onClick={run((v) => insertBlock(v, '[text](https://)'))} />
      <IconBtn icon="table" title="Table" onClick={run((v) => insertBlock(v, TABLE))} />
      <span className="oc-tb-spacer" />
      <button className="oc-tb-btn oc-tb-text" title={mode === 'edit' ? 'Preview' : 'Edit'} onClick={onToggleMode}>
        <Icon name={mode === 'edit' ? 'eye' : 'pencil'} size={15} />
        <span style={{ marginLeft: 5 }}>{mode === 'edit' ? 'Preview' : 'Edit'}</span>
      </button>
    </div>
  );
}
