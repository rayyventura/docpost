import { useState, type AnimationEvent, type ReactNode } from 'react';

interface ContentRevealProps {
  children: ReactNode;
  className?: string;
}

export function ContentReveal({ children, className }: ContentRevealProps) {
  const [popped, setPopped] = useState(false);

  function handleAnimationEnd(event: AnimationEvent<HTMLDivElement>) {
    if (event.animationName !== 'contentPop') return;
    setPopped(true);
  }

  const classNames = [popped ? null : 'content-reveal', className].filter(Boolean).join(' ');

  return (
    <div className={classNames || undefined} onAnimationEnd={handleAnimationEnd}>
      {children}
    </div>
  );
}
