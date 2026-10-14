import type { ReactNode } from 'react';
import { useT } from '../i18n';
import type { AsyncState } from '../lib/useAsync';
import { ErrorBox } from './ErrorBox';
import { PageLoading } from './Spinner';

/** Loading spinner, error with retry, then `children(data)` once loaded. */
export function AsyncBlock<T>({ state, children }: { state: AsyncState<T>; children: (data: T) => ReactNode }) {
  const t = useT();
  return (
    <>
      {state.loading && state.data === undefined && <PageLoading label={t('common.loading')} />}
      {state.error != null && <ErrorBox error={state.error} onRetry={state.reload} />}
      {state.data !== undefined && children(state.data)}
    </>
  );
}
