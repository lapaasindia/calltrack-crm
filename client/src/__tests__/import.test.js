import { describe, it, expect } from 'vitest';
import { autoMap } from '../pages/ImportPage.jsx';

describe('import column auto-map (QA-9)', () => {
  it('maps a column literally named Notes, plus the usual suspects', () => {
    const m = autoMap(['Full Name', 'Phone Number', 'City', 'Source', 'Notes']);
    expect(m).toEqual({ name: 'Full Name', phone: 'Phone Number', city: 'City', source: 'Source', notes: 'Notes' });
  });
  it('never maps one header to two fields and still finds message/remarks', () => {
    const m = autoMap(['name', 'mobile', 'Remarks', 'Alt Phone', 'email']);
    expect(m.name).toBe('name');
    expect(m.phone).toBe('mobile');
    expect(m.alt_phone).toBe('Alt Phone');
    expect(m.notes).toBe('Remarks');
    expect(m.email).toBe('email');
    expect(new Set(Object.values(m)).size).toBe(Object.values(m).length);
  });
});
