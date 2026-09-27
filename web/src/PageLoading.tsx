interface PageLoadingProps {
  label: string;
}

export function PageLoading({ label }: PageLoadingProps) {
  return (
    <div className="page-loading" role="status" aria-live="polite" aria-label={label}>
      <div className="loading-spinner" aria-hidden="true" />
      <p className="page-loading-label">{label}</p>
    </div>
  );
}
