import type { ReactNode } from 'react';

export type PanelProps = {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md';
};

/** The glass surface primitive: blur, tint, hairline border, top highlight. */
export function Panel({ children, className, padding = 'md' }: PanelProps) {
  return (
    <div className={`bs-panel bs-panel--pad-${padding}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}
