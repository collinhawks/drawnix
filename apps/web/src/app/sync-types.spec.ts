import { EMPTY_DOCUMENT, isEmptyDocument } from './sync-types';

describe('sync document helpers', () => {
  it('treats the empty document as empty', () => {
    expect(isEmptyDocument(EMPTY_DOCUMENT())).toBe(true);
  });

  it('treats a populated document as non-empty', () => {
    expect(
      isEmptyDocument({
        children: [{} as never],
        viewport: null,
        theme: null,
      })
    ).toBe(false);
  });
});
