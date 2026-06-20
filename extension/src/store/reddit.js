import { signal } from '@preact/signals';

// NS fork: controls whether r/novi_sad (source='reddit') links show in the feed.
// Defaults to on; persisted to localStorage.
export const showReddit = signal(
  localStorage.getItem('dn_show_reddit') !== 'false'
);

export function setShowReddit(val) {
  showReddit.value = val;
  localStorage.setItem('dn_show_reddit', String(val));
}
