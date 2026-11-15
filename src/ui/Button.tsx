import type { ReactNode } from 'react';

export type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
};

export function Button({
  variant = 'secondary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  children,
  onClick,
  type = 'button',
}: ButtonProps) {
  const busy = Boolean(loading);
  return (
    <button
      type={type}
      className={`bs-btn bs-btn--${variant} bs-btn--${size}${busy ? ' is-loading' : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {busy ? (
        <span className="bs-spinner" aria-hidden="true" />
      ) : icon ? (
        <span className="bs-btn__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children != null && <span className="bs-btn__label">{children}</span>}
    </button>
  );
}
