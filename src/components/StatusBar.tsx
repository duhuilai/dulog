interface Props {
  lineCount?: number;
  fileSize?: number;
  fileType: string;
  dirty: boolean;
  encoding?: string;
  lineEnding?: string;
  cursorLine?: number;
  cursorCol?: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatLines(n: number): string {
  if (n < 10000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

export function StatusBar({
  lineCount,
  fileSize,
  fileType,
  dirty,
  encoding = "UTF-8",
  lineEnding = "LF",
  cursorLine,
  cursorCol,
}: Props) {
  return (
    <div className="statusbar-bottom">
      <div className="statusbar-left">
        {cursorLine !== undefined && (
          <span>Ln {cursorLine}{cursorCol !== undefined ? `, Col ${cursorCol}` : ""}</span>
        )}
        {lineCount !== undefined && <span>已索引 {formatLines(lineCount)} 行</span>}
        <span>{encoding}</span>
        <span>{lineEnding}</span>
        <span>{fileType}</span>
        {dirty && <span className="status-dirty">未保存的更改 ●</span>}
      </div>
      <div className="statusbar-right">
        {fileSize !== undefined && <span>{formatBytes(fileSize)}</span>}
      </div>
    </div>
  );
}
