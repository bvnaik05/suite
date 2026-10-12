// Updates applied from the server; everything else in the doc is this tab's own work
export const REMOTE = Symbol('collab-remote')
// Another tab's unsent work, applied here so this tab shows and sends it
export const ADOPT = Symbol('collab-adopt')
