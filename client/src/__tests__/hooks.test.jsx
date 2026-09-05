import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { useRequest, useSubmit, useDebouncedValue } from '../hooks.js';

function Probe({ fetcher, dep }) {
  const { data, error, loading, reload } = useRequest(fetcher, [dep]);
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : error ? `error:${error.message}` : `data:${JSON.stringify(data)}`}</span>
      <button type="button" onClick={reload}>reload</button>
    </div>
  );
}

describe('useRequest', () => {
  it('loads, exposes errors, reloads and passes an abort signal', async () => {
    let calls = 0;
    const fetcher = vi.fn(async ({ signal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return { n: calls };
    });
    render(<Probe fetcher={fetcher} dep={1} />);
    expect(screen.getByTestId('state').textContent).toBe('loading');
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('data:{"n":1}'));
    fireEvent.click(screen.getByText('reload'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error:boom'));
    fireEvent.click(screen.getByText('reload'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('data:{"n":3}'));
  });
  it('refetches when deps change and aborts the previous request', async () => {
    const seen = [];
    const fetcher = vi.fn(({ signal }) => new Promise((resolve) => {
      seen.push(signal);
      setTimeout(() => resolve('ok'), 5);
    }));
    const { rerender } = render(<Probe fetcher={fetcher} dep="a" />);
    rerender(<Probe fetcher={fetcher} dep="b" />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('data:"ok"'));
    expect(seen[0].aborted).toBe(true);
    expect(seen[seen.length - 1].aborted).toBe(false);
  });
});

function SubmitProbe({ fn }) {
  const [run, saving] = useSubmit(fn);
  return <button type="button" disabled={saving} onClick={run}>{saving ? 'saving' : 'go'}</button>;
}

describe('useSubmit', () => {
  it('ignores re-entrant calls while in flight and resets saving', async () => {
    let resolve;
    const fn = vi.fn(() => new Promise((r) => { resolve = r; }));
    render(<SubmitProbe fn={fn} />);
    const btn = screen.getByRole('button');
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe('saving');
    expect(btn.disabled).toBe(true);
    await act(async () => { resolve(); });
    expect(btn.textContent).toBe('go');
    await act(async () => { fireEvent.click(btn); });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

function DebounceProbe({ value }) {
  const d = useDebouncedValue(value, 50);
  return <span data-testid="d">{d}</span>;
}

describe('useDebouncedValue', () => {
  it('settles after the delay', async () => {
    const { rerender } = render(<DebounceProbe value="a" />);
    rerender(<DebounceProbe value="ab" />);
    rerender(<DebounceProbe value="abc" />);
    expect(screen.getByTestId('d').textContent).toBe('a');
    await waitFor(() => expect(screen.getByTestId('d').textContent).toBe('abc'));
  });
});
