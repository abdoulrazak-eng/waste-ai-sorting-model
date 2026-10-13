export const SORTING_API_BASE = (import.meta.env.VITE_SORTING_API_BASE || '/api').replace(/\/$/, '');
let sessionGeneration = 0;
export function invalidateSortingRequests() { sessionGeneration += 1; }

export async function sortingFetch(url, options = {}) {
  const generation = sessionGeneration;
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 401 && generation === sessionGeneration) window.dispatchEvent(new Event('sorting-session-expired'));
    const body = await response.json().catch(() => ({}));
    const message = typeof body.detail === 'string' ? body.detail : 'The sorting request could not be completed.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (url.endsWith('/inference') && generation === sessionGeneration) window.dispatchEvent(new Event('sorting-result-saved'));
  return response;
}

export async function sortingJson(path, body) {
  const response = await sortingFetch(`${SORTING_API_BASE}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return response.json();
}
