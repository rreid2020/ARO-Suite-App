/**
 * Guided walkthrough overlay.
 *
 * Sits on the live unit screens. Skip, Done, Escape, How to use it, or a
 * sidebar destination that is not a tour step all leave it. The dots jump.
 */

import React, { useEffect, useRef } from 'react';
import { useStore, useTenant, useUnit } from '../../core/store';
import { walkthroughFor } from '../../core/guide';

export function Walkthrough() {
  const { ui, setUi } = useStore();
  const tenant = useTenant();
  const unit = useUnit();
  const nextRef = useRef<HTMLButtonElement>(null);

  const steps = tenant ? walkthroughFor(tenant.kind) : [];
  const index = ui.tour;
  const active = index != null && tenant && unit && steps[index];
  const step = active ? steps[index] : null;
  const last = Boolean(step && index === steps.length - 1);

  useEffect(() => {
    if (ui.tour == null) return;
    if (!unit || !tenant || !walkthroughFor(tenant.kind).length) {
      setUi({ tour: null });
    }
  }, [ui.tour, unit, tenant, setUi]);

  useEffect(() => {
    if (!step) return;
    nextRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setUi({ tour: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, setUi]);

  if (!step || index == null) return null;

  const go = (next: number) => {
    const target = steps[next];
    if (!target) {
      setUi({ tour: null });
      return;
    }
    setUi({ screen: target.screen, tab: '', sub: '', tour: next });
    window.scrollTo(0, 0);
  };

  return (
    <>
      <div className="tour-backdrop" aria-hidden="true" />
      <div
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
      >
        <div className="kicker">Step {index + 1} of {steps.length}</div>
        <h2 id="tour-title" className="tour-title">{step.title}</h2>
        <p className="tour-body">{step.body}</p>
        <div className="tour-foot">
          <div className="tour-dots" role="tablist" aria-label="Walkthrough steps">
            {steps.map((s, i) => (
              <button
                key={`${s.screen}-${i}`}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`${s.title}, step ${i + 1} of ${steps.length}`}
                className={i === index ? 'tour-dot on' : 'tour-dot'}
                onClick={() => go(i)}
              />
            ))}
          </div>
          <div className="tour-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUi({ tour: null })}>
              Skip
            </button>
            <button
              ref={nextRef}
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => last ? setUi({ tour: null }) : go(index + 1)}
            >
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
