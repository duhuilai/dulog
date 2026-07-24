interface Props {
  name: string;
  x: number;
  y: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirm({ name, x, y, onConfirm, onCancel }: Props) {
  return (
    <div
      className="delete-popover"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="delete-popover-text">
        确定删除 <span className="delete-popover-name">{name}</span>？
      </div>
      <div className="delete-popover-actions">
        <button onClick={onCancel}>取消</button>
        <button className="btn-danger" onClick={onConfirm}>
          删除
        </button>
      </div>
    </div>
  );
}
