import type { ReactNode } from 'react';

export function Card({
  title,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      className={`card${className ? ` ${className}` : ''}`}
      id={id}
      aria-labelledby={title && id ? `${id}-title` : undefined}
    >
      {(title || actions) && (
        <header className="card-head">
          {title && (
            <h2 className="card-title" id={id ? `${id}-title` : undefined}>
              {title}
            </h2>
          )}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
