interface PageLoadingProps {
  label: string;
}

export function PageLoading({ label }: PageLoadingProps) {
  return (
    <div className="page-loading" role="status" aria-live="polite" aria-label={label}>
      <div className="loading-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="page-loading-label">{label}</p>
    </div>
  );
}
