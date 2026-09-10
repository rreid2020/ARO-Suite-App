/**
 * How to use it — the landing guide for the open tenant kind.
 *
 * Auditor copy is the Mode 1 recalculation. A reporting entity gets the
 * module-of-record path. "Show me instead" opens the live screens under
 * the walkthrough overlay; it is not a separate route tree.
 */

import React from 'react';
import { useStore, useTenant, useUnitWord } from '../../core/store';
import { guideFor, openToolTarget, startWalkthroughTarget } from '../../core/guide';

export function HowTo() {
  const { state, ui, setUi } = useStore();
  const tenant = useTenant()!;
  const unitWord = useUnitWord();
  const guide = guideFor(tenant.kind);

  const openTool = () => {
    const target = openToolTarget(tenant.kind, state, tenant.id, ui.unitId);
    setUi({ ...target, tab: '', sub: '', tour: null });
    window.scrollTo(0, 0);
  };

  const showMe = () => {
    const target = startWalkthroughTarget(tenant.kind, state, tenant.id, ui.unitId);
    if ('needUnit' in target) {
      setUi({
        screen: 'setup',
        tour: null,
        toast: {
          kind: 'refused',
          text: `Create a ${unitWord.toLowerCase()} in Company setup first — the walkthrough runs on the live screens.`,
        },
      });
      return;
    }
    setUi({ ...target, tab: '', sub: '' });
    window.scrollTo(0, 0);
  };

  return (
    <article className="howto">
      <header className="howto-hero">
        <div>
          <div className="kicker">{guide.kicker}</div>
          <h1 className="howto-title">How to use it</h1>
        </div>
        <button type="button" className="btn btn-primary" onClick={openTool}>
          Open the tool
        </button>
      </header>

      <p>
        <button type="button" className="btn btn-primary" onClick={showMe}>
          Show me instead — 30 seconds
        </button>
      </p>

      <div className="howto-intro">
        {guide.intro.map((p) => <p key={p.slice(0, 40)}>{p}</p>)}
      </div>

      <div className="howto-pillars">
        {guide.pillars.map((p) => (
          <div key={p.title}>
            <div className="kicker">{p.title}</div>
            <p>{p.body}</p>
          </div>
        ))}
      </div>

      <div className="howto-split">
        <nav className="howto-toc" aria-label="On this page">
          <div className="kicker">On this page</div>
          <a href="#five-minute">The five-minute version</a>
          {guide.sections.map((s) => (
            <a key={s.id} href={`#${s.id}`}>{s.title}</a>
          ))}
          <a href="#questions">Questions people ask</a>
          <a href="#your-data">Your data</a>
        </nav>

        <div className="howto-body">
          <section id="five-minute" className="howto-section">
            <h2>The five-minute version</h2>
            <p className="howto-lead">{guide.fiveMinuteLead}</p>
            <ol className="howto-minutes">
              {guide.fiveMinute.map((item) => (
                <li key={item.title}>
                  <strong>{item.title}.</strong> {item.body}
                </li>
              ))}
            </ol>
          </section>

          {guide.sections.map((section) => (
            <section key={section.id} id={section.id} className="howto-section">
              <h2>{section.title}</h2>
              {section.body.map((p) => <p key={p.slice(0, 48)}>{p}</p>)}
            </section>
          ))}

          <section id="questions" className="howto-section">
            <h2>Questions people ask</h2>
            {guide.faq.map((item) => (
              <div key={item.q} className="howto-faq">
                <h3>{item.q}</h3>
                <p>{item.a}</p>
              </div>
            ))}
          </section>

          <section id="your-data" className="howto-section">
            <h2>Your data</h2>
            {guide.data.map((p) => <p key={p.slice(0, 48)}>{p}</p>)}
          </section>
        </div>
      </div>
    </article>
  );
}
