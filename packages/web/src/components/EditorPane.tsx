import type { TreeNodeDto } from '@oc/shared';
import { DocEditor } from '../editor/DocEditor';
import { BlobView } from '../editor/BlobView';

export function EditorPane({ node, onClose }: { node: TreeNodeDto; onClose: () => void }) {
  return node.isText ? (
    <DocEditor key={node.docId} node={node} onClose={onClose} />
  ) : (
    <BlobView key={node.docId} node={node} onClose={onClose} />
  );
}
