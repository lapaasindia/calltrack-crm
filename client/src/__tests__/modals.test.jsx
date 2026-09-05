import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Modal, PromptModal, ConfirmModal, ErrorState, Field } from '../components.jsx';

describe('Modal', () => {
  it('has dialog semantics, closes on Escape and locks the body', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Modal title="Hello" onClose={onClose}><button type="button">ok</button></Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(screen.getByText('Hello').id);
    expect(document.body.style.position).toBe('fixed');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.body.style.position).toBe('');
  });
  it('traps Tab inside the dialog', () => {
    render(<Modal title="T" onClose={() => {}}><button type="button">first</button><button type="button">last</button></Modal>);
    screen.getByText('last').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('last'));
  });
});

describe('PromptModal', () => {
  it('submits the trimmed value and disables submit while a required field is empty', async () => {
    const onSubmit = vi.fn();
    render(<PromptModal title="Reason" label="Why" required submitLabel="Go" onSubmit={onSubmit} onClose={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why *'), { target: { value: '  lost to competitor  ' } });
    expect(btn.disabled).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    expect(onSubmit).toHaveBeenCalledWith('lost to competitor');
  });
  it('cancel calls onClose and never onSubmit (CLIENT-5)', () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<PromptModal title="Reason" required onSubmit={onSubmit} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('pre-fills defaultValue', () => {
    render(<PromptModal title="Name" label="Lead name" defaultValue="Ravi" onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('Lead name').value).toBe('Ravi');
  });
});

describe('ConfirmModal', () => {
  it('confirms once even on a double click and shows the message', async () => {
    let resolve;
    const onConfirm = vi.fn(() => new Promise((r) => { resolve = r; }));
    render(<ConfirmModal title="Delete?" message="Gone for good" confirmLabel="Delete" danger onConfirm={onConfirm} onClose={() => {}} />);
    expect(screen.getByText('Gone for good')).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn.className).toContain('danger');
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
  });
});

describe('ErrorState / Field', () => {
  it('describes network vs forbidden errors and retries', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState error={{ message: "Can't reach the office computer", network: true }} onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain("Can't reach the office computer");
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalled();
    rerender(<ErrorState error={{ message: 'Owner only', status: 403, data: { request_id: 'r1' } }} />);
    expect(screen.getByRole('alert').textContent).toContain("You don't have access");
    expect(screen.getByRole('alert').textContent).toContain('Ref r1');
  });
  it('Field wires label ↔ control', () => {
    render(<Field label="Phone"><input /></Field>);
    expect(screen.getByLabelText('Phone').tagName).toBe('INPUT');
  });
});
