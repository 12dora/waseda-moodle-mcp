import { Component, type ReactNode } from 'react';
import { useT } from '../i18n';
import { Button } from './Button';

function CrashScreen() {
  const t = useT();
  return (
    <div className="center-page" role="alert">
      <p>{t('common.crashed')}</p>
      <Button variant="primary" onClick={() => location.reload()}>
        {t('common.reload')}
      </Button>
    </div>
  );
}

/** Last-resort boundary so a render error never leaves a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(error);
  }

  override render(): ReactNode {
    return this.state.failed ? <CrashScreen /> : this.props.children;
  }
}
