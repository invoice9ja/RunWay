import type { ReactNode } from 'react';

/**
 * A card section: heading bar plus body.
 *
 * Nineteen of these were hand-rolled across ten pages, which is why the heading
 * padding, the title-to-subtitle gap and the kicker's baseline drifted between
 * pages. One component, so the grammar cannot diverge again.
 */
export function Section({
  title,
  subtitle,
  kicker,
  children,
  actions,
  testId,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Short status word, uppercased by CSS. */
  kicker?: ReactNode;
  /** Buttons on the right of the heading bar. */
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section
      className={`section-card${className ? ` ${className}` : ''}`}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <div className="section-heading">
        <div className="section-title-wrap">
          <h2 className="section-title">{title}</h2>
          {subtitle && <p className="section-subtitle">{subtitle}</p>}
        </div>
        {(kicker || actions) && (
          <div className="section-heading-end">
            {actions}
            {kicker && <span className="section-kicker">{kicker}</span>}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * A label/value tile.
 *
 * `param-value` renders at 16px serif, which is right for a headline figure and
 * wrong for an address. Pass `mono` for anything machine-generated so digits and
 * hashes stay legible and align in columns.
 */
export function Param({
  label,
  value,
  mono,
  testId,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  testId?: string;
}) {
  return (
    <div className="param">
      <div className="param-label">{label}</div>
      <div
        className={`param-value${mono ? ' param-value-mono' : ''}`}
        {...(testId ? { 'data-testid': testId } : {})}
      >
        {value}
      </div>
    </div>
  );
}

/** A grid of {@link Param} tiles. */
export function ParamGrid({ children }: { children: ReactNode }) {
  return <div className="param-grid">{children}</div>;
}