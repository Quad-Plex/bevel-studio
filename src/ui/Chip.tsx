import type { ReactNode } from 'react';

export type ChipProps = {
  tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success';
  icon?: ReactNode;
  children: ReactNode;
};

export function Chip({ tone = 'neutral', icon, children }: ChipProps) {
  return (
    <span className={`bs-chip bs-chip--${tone}`}>
      {icon && (
        <span className="bs-chip__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="bs-chip__text">{children}</span>
    </span>
  );
}
