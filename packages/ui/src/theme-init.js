/* Load before styles/React. No secrets are stored; unavailable storage is harmless. */
(() => {
  let preference = 'system';
  try { preference = localStorage.getItem('omnihub.theme') || 'system'; } catch {}
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'system';
  document.documentElement.dataset.theme = preference === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
})();
