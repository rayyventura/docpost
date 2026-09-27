import type { ReactNode } from 'react';

interface ContentRevealProps {
  children: ReactNode;
  className?: string;
}

export function ContentReveal({ children, className }: ContentRevealProps) {
  return (
    <div className={className ? `content-reveal ${className}` : 'content-reveal'}>
      {children}
    </div>
  );
}
