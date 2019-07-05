#!/usr/bin/env python3
import os
import http.server
import socketserver

os.chdir("build")

PORT = 8080

'''
class pyodideHttpServer(http.server.SimpleHTTPRequestHandler):

    def __init__(self, request, client_address, server):
        self.extensions_map.update({
            '.wasm': 'application/wasm',
            #    '.data': 'application/wasm',
        })

        print(dir(request))
        return super().__init__(request, client_address, server)
'''


Handler = http.server.SimpleHTTPRequestHandler

Handler.extensions_map.update({
    '.wasm': 'application/wasm',
#    '.data': 'application/wasm',
})

#for i, j in sorted(Handler.extensions_map.items(), key=lambda x: x[0]):
#    print(i, j)

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.allow_reuse_address = True
    print("serving at port", PORT)
    httpd.serve_forever()
