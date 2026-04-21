import http.server, socketserver, os, sys

DIST = sys.argv[1]
PORT = int(sys.argv[2])

class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        fs_path = os.path.join(DIST, path.lstrip('/'))
        sys.stderr.write(f'[DEBUG] path={path} fs_path={fs_path} isfile={os.path.isfile(fs_path)}\n')
        sys.stderr.flush()
        # If the path is a file that exists, serve it.
        # If path is a directory with index.html, serve that.
        # Otherwise fall back to the SPA index.html.
        if os.path.isfile(fs_path) or (os.path.isdir(fs_path) and os.path.isfile(os.path.join(fs_path, 'index.html'))):
            return super().do_GET()
        # SPA fallback
        with open(os.path.join(DIST, 'index.html'), 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

os.chdir(DIST)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), SPAHandler) as httpd:
    print(f'Serving {DIST} on http://127.0.0.1:{PORT}/ (SPA fallback enabled)')
    httpd.serve_forever()
