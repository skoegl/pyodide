PYODIDE_ROOT=$(abspath .)

include Makefile.envs

.PHONY=check

FILEPACKAGER=$$EM_DIR/tools/file_packager.py
UGLIFYJS=$(PYODIDE_ROOT)/node_modules/.bin/uglifyjs

CPYTHONROOT=cpython
CPYTHONLIB=$(CPYTHONROOT)/installs/python-$(PYVERSION)/lib/python$(PYMINOR)

CC=emcc
CXX=em++

all: check \
	build/pyodide.asm.js \
	build/pyodide.js \
	build/console.html \
	build/packages.json \
	build/webworker.js \
	build/webworker_dev.js
	echo -e "\nSUCCESS!"


build/pyodide.asm.js: \
	src/core/docstring.o \
	src/core/error_handling.o \
	src/core/numpy_patch.o \
	src/core/hiwire.o \
	src/core/js2python.o \
	src/core/jsproxy.o \
	src/core/keyboard_interrupt.o \
	src/core/main.o  \
	src/core/pyproxy.o \
	src/core/python2js_buffer.o \
	src/core/python2js.o \
	$(wildcard src/pyodide-py/pyodide/*.py) \
	$(CPYTHONLIB)
	date +"[%F %T] Building pyodide.asm.js..."
	[ -d build ] || mkdir build
	$(CXX) -v -s EXPORT_NAME="'_createPyodideModule'" -o build/pyodide.asm.js $(filter %.o,$^) \
		$(MAIN_MODULE_LDFLAGS) -s FORCE_FILESYSTEM=1 \
		--preload-file $(CPYTHONLIB)@/lib/python$(PYMINOR) \
		--preload-file src/pyodide-py/pyodide@/lib/python$(PYMINOR)/site-packages/pyodide \
		--preload-file src/pyodide-py/_pyodide@/lib/python$(PYMINOR)/site-packages/_pyodide \
		--exclude-file "*__pycache__*" \
		--exclude-file "*/test/*"		\
		--exclude-file "*/tests/*"
	# Strip out C++ symbols which all start __Z.
	# There are 4821 of these and they have VERY VERY long names.
	# Reduces size of pyodide.asm.js by a factor of 2.
	# I messed around with striping more and could remove another 400kb or so
	# but the regexes I got were generated.
	# To show some stats on the symbols you can use the following:
	# cat build/pyodide.asm.js | grep -ohE 'var _{0,5}.' | sort | uniq -c | sort -nr | head -n 20
	sed -i -E 's/var __Z[^;]*;//g' build/pyodide.asm.js
	date +"[%F %T] done building pyodide.asm.js."


env:
	env


.PHONY: build/pyodide.js
build/pyodide.js: src/pyodide.js
	cp $< $@
	sed -i -e 's#{{ PYODIDE_BASE_URL }}#$(PYODIDE_BASE_URL)#g' $@


build/test.html: src/templates/test.html
	cp $< $@


.PHONY: build/console.html
build/console.html: src/templates/console.html
	cp $< $@
	sed -i -e 's#{{ PYODIDE_BASE_URL }}#$(PYODIDE_BASE_URL)#g' $@


.PHONY: docs/_build/html/console.html
docs/_build/html/console.html: src/templates/console.html
	mkdir -p docs/_build/html
	cp $< $@
	sed -i -e 's#{{ PYODIDE_BASE_URL }}#$(PYODIDE_BASE_URL)#g' $@


.PHONY: build/webworker.js
build/webworker.js: src/webworker.js
	cp $< $@
	sed -i -e 's#{{ PYODIDE_BASE_URL }}#$(PYODIDE_BASE_URL)#g' $@


.PHONY: build/webworker_dev.js
build/webworker_dev.js: src/webworker.js
	cp $< $@
	sed -i -e 's#{{ PYODIDE_BASE_URL }}#./#g' $@

update_base_url: \
	build/console.html \
	build/pyodide.js \
	build/webworker.js

test: all
	pytest src emsdk/tests packages/*/test* pyodide_build -v


lint:
	# check for unused imports, the rest is done by black
	flake8 --select=F401 src tools pyodide_build benchmark conftest.py docs
	clang-format-6.0 -output-replacements-xml `find src -type f -regex ".*\.\(c\|h\|js\)"` | (! grep '<replacement ')
	black --check .
	mypy --ignore-missing-imports pyodide_build/ src/ packages/micropip/micropip/ packages/*/test* conftest.py docs


apply-lint:
	./tools/apply-lint.sh

benchmark: all
	python benchmark/benchmark.py $(HOSTPYTHON) build/benchmarks.json
	python benchmark/plot_benchmark.py build/benchmarks.json build/benchmarks.png


clean:
	rm -fr build/*
	rm -fr src/*/*.o
	rm -fr node_modules
	make -C packages clean
	echo "The Emsdk, CPython are not cleaned. cd into those directories to do so."

clean-py: clean
	make -C cpython clean
	#rm -fr cpython/build

clean-all: clean
	make -C emsdk clean
	make -C cpython clean
	rm -fr cpython/build

%.o: %.c $(CPYTHONLIB) $(wildcard src/**/*.h src/**/*.js)
	$(CC) -o $@ -c $< $(MAIN_MODULE_CFLAGS) -Isrc/core/


build/test.data: $(CPYTHONLIB) $(UGLIFYJS)
	( \
		cd $(CPYTHONLIB)/test; \
		find . -type d -name __pycache__ -prune -exec rm -rf {} \; \
	)
	( \
		cd build; \
		python $(FILEPACKAGER) test.data --lz4 --preload ../$(CPYTHONLIB)/test@/lib/python$(PYMINOR)/test --js-output=test.js --export-name=pyodide._module --exclude __pycache__ \
	)
	$(UGLIFYJS) build/test.js -o build/test.js


$(UGLIFYJS): emsdk/emsdk/.complete
	npm i --no-save uglify-js
	touch -h $(UGLIFYJS)


$(CPYTHONLIB): emsdk/emsdk/.complete $(PYODIDE_EMCC) $(PYODIDE_CXX)
	date +"[%F %T] Building cpython..."
	make -C $(CPYTHONROOT)
	date +"[%F %T] done building cpython..."

build/packages.json: FORCE
	date +"[%F %T] Building packages..."
	make -C packages
	date +"[%F %T] done building packages..."

emsdk/emsdk/.complete:
	date +"[%F %T] Building emsdk..."
	make -C emsdk
	date +"[%F %T] done building emsdk."

FORCE:

check: $(UGLIFYJS)
	./tools/dependency-check.sh

minimal :
	PYODIDE_PACKAGES+=",micropip" make

debug :
	EXTRA_CFLAGS+=" -D DEBUG_F" \
	PYODIDE_PACKAGES+=", micropip, pyparsing, pytz, packaging, kiwisolver, " \
	make

nano: FORCE
	# smallest version for flare
	CURRENT_MODE="_nano" PYODIDE_PACKAGES="False" make

pico: FORCE
	# smallest possible python version
	CURRENT_MODE="_pico" PYODIDE_PACKAGES="False" make
