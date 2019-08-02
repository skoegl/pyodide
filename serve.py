#!/usr/bin/env python3
import os, socketserver
from http.server import SimpleHTTPRequestHandler

os.chdir("build")

PORT = 8383


class pyodideHttpServer(SimpleHTTPRequestHandler):

    def __init__(self, request, client_address, server):
        self.extensions_map.update({
            '.wasm': 'application/wasm',
        })

        super().__init__(request, client_address, server)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        #self.send_header("Access-Control-Allow-Origin", "https://phorward.info/tmp/pyodide")
        super().end_headers()


Handler = pyodideHttpServer

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.allow_reuse_address = True
    print("serving at port", PORT)
    httpd.serve_forever()
