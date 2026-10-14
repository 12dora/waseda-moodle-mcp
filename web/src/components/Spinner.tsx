export function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  const icon = <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
  if (!label) return icon;
  return (
    <span role="status" className="spinner-wrap">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function PageLoading({ label }: { label: string }) {
  return (
    <div className="page-loading">
      <Spinner size={24} label={label} />
    </div>
  );
}
