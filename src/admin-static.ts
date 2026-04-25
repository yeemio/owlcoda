/**
 * Serve the compiled admin/ client bundle under /admin/.
 * - dist/admin/index.html for /admin and /admin/
 * - dist/admin/assets/* for hashed JS/CSS
 * - Returns a friendly error page when the bundle is missing
 * - Returns `false` when the path should fall through to legacy /admin/* handlers
 *
 * Runs BEFORE the adminToken bearer gate — these files are just UI shell.
 * All sensitive data comes through /admin/api (Phase α handler), which has
 * its own session-based auth.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export function getAdminStaticDistDir(): string {
  // Resolve relative to this compiled module, NOT the user's cwd. Same logic
  // as getAdminBundleDir — bundle ships inside the installed package.
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'dist', 'admin')
}

export function handleAdminStatic(
  req: IncomingMessage,
  res: ServerResponse,
  options: { distDir?: string } = {},
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const rawUrl = req.url ?? ''
  const pathOnly = rawUrl.split('?')[0] ?? rawUrl

  if (pathOnly !== '/admin' && !pathOnly.startsWith('/admin/')) return false
  if (pathOnly.startsWith('/admin/api/')) return false

  const distDir = options.distDir ?? getAdminStaticDistDir()
  const indexPath = join(distDir, 'index.html')

  if (!existsSync(indexPath)) {
    if (pathOnly === '/admin' || pathOnly === '/admin/' || pathOnly === '/admin/index.html' || pathOnly.startsWith('/admin/assets/')) {
      sendBundleMissing(res, distDir, indexPath)
      return true
    }
    return false
  }

  if (pathOnly === '/admin' || pathOnly === '/admin/' || pathOnly === '/admin/index.html') {
    return sendFile(req, res, indexPath, true)
  }

  if (!isStaticAssetPath(pathOnly)) {
    return false
  }

  // Strip /admin/ prefix and resolve inside dist dir
  const rel = pathOnly.slice('/admin/'.length)
  const target = normalize(join(distDir, rel))

  // Path traversal guard
  if (!target.startsWith(distDir + '/') && target !== distDir) {
    return false
  }

  if (!fileExists(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`Admin asset not found: ${pathOnly}`)
    return true
  }

  return sendFile(req, res, target, false)
}

function isStaticAssetPath(pathOnly: string): boolean {
  return pathOnly.startsWith('/admin/assets/') || /^\/admin\/[^/]+\.[A-Za-z0-9]+$/.test(pathOnly)
}

function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string, isHtml: boolean): boolean {
  try {
    const body = readFileSync(filePath)
    const ext = extOf(filePath)
    const mime = MIME[ext] ?? 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': body.length.toString(),
      // Hashed assets are immutable; HTML and fallbacks should revalidate
      'Cache-Control': isHtml
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    })
    if (req.method === 'HEAD') {
      res.end()
    } else {
      res.end(body)
    }
    return true
  } catch {
    return false
  }
}

function sendBundleMissing(res: ServerResponse, distDir: string, indexPath: string): void {
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>OwlCoda Admin Bundle Missing</title></head>
<body>
  <h1>OwlCoda Admin bundle is not built yet</h1>
  <p>Expected admin assets under <code>${distDir}</code>.</p>
  <p>Build the browser admin bundle so the server can serve <code>${indexPath}</code>.</p>
</body>
</html>`
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
  res.end(body)
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function extOf(p: string): string {
  const idx = p.lastIndexOf('.')
  return idx === -1 ? '' : p.slice(idx).toLowerCase()
}
