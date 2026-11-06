// Segment once per operation, keeping DOM offsets in UTF-16 code units.
// Chrome supports Intl.Segmenter in both content scripts and service workers.
const PTGraphemes = {
  segmenter: new Intl.Segmenter(undefined, { granularity: 'grapheme' }),

  split(text) {
    return Array.from(this.segmenter.segment(text), part => part.segment);
  },

  deletionRange(text, start, end = start) {
    let from = start, to = end;
    for (const part of this.segmenter.segment(text)) {
      const next = part.index + part.segment.length;
      if (start === end) {
        if (part.index < start && next >= start) return [part.index, next];
      } else {
        if (part.index < start && next > start) from = part.index;
        if (part.index < end && next > end) to = next;
      }
      if (part.index >= end) break;
    }
    return [from, to];
  }
};
