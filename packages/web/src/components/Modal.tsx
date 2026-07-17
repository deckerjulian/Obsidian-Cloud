import { useRef, type MouseEvent, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // Only close on a click that both STARTED and ended on the overlay. A plain
  // onClick also fires when a text selection (e.g. dragging inside a passphrase
  // field) is released outside the dialog — which would discard the input.
  const downOnOverlay = useRef(false);
  const onOverlayMouseDown = (e: MouseEvent) => {
    downOnOverlay.current = e.target === e.currentTarget;
  };
  const onOverlayClick = (e: MouseEvent) => {
    if (downOnOverlay.current && e.target === e.currentTarget) onClose();
  };
  return (
    <div className="oc-modal-overlay" onMouseDown={onOverlayMouseDown} onClick={onOverlayClick}>
      <div className="oc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="oc-modal-header">
          <h3>{title}</h3>
          <button className="oc-icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="oc-modal-body">{children}</div>
        {footer && <div className="oc-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
