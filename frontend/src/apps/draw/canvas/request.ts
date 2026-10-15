let csrfToken: Promise<string> | undefined

async function token() {
  csrfToken ??= (async () => {
    const current = window.csrf_token
    if (current && current !== '{{ csrf_token }}') return current
    const desk = await fetch('/desk', { credentials: 'same-origin' }).then(response => response.text())
    const found = desk.match(/frappe.csrf_token\s*=\s*["']([^"']+)/)?.[1]
    if (!found) throw new Error('Could not get the Frappe session token. Reload the page.')
    return found
  })()
  try { return await csrfToken }
  catch (error) { csrfToken = undefined; throw error }
}

export async function drawRequest(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': await token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    let message = data?.message
    try { message ||= JSON.parse(JSON.parse(data?._server_messages ?? '[]')[0] ?? '{}').message }
    catch {}
    throw new Error(message || data?.exc_type || `Frappe returned HTTP ${response.status}`)
  }
  return method === 'DELETE' ? undefined : response.json()
}
