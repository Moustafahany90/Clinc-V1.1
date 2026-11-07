/**
 * Fixed clinic letterhead. Header, footer and signature are the same on every
 * report, so they live here in ONE place. Edit the text here (and only here).
 */
export const LETTERHEAD = {
  /** Right-to-left header lines, top to bottom. The first line is the doctor name. */
  headerLinesRtl: [
    'د/ منيره علي علي',
    'استشاري الموجات الصوتية و طب الجنين',
    'بوحده طب الجنين- جامعه عين شمس',
  ],
  footerPhone: 'Tel : 01113735454 - 01555579454',
  footerAddressRtl: '10 ش سامي عبد العال – ارض الجولف – مصر الجديدة',
  /** [closing, name, title line, university line] */
  signatureLines: [
    'Best regards.',
    'Dr. Monira Ali Ali',
    'Ultrasound and fetal medicine consultant, Fetal medicine unit,',
    'Ain shams University.',
  ],
} as const;
