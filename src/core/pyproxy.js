/**
 * Every public Python entrypoint goes through this file! The main entrypoint is
 * the callPyObject method, but of course one can also execute arbitrary code
 * via the various __dundermethods__ associated to classes.
 *
 * The only entrypoint into Python that avoids this file is our bootstrap method
 * runPythonSimple which is defined in main.c
 *
 * Any time we call into wasm, the call should be wrapped in a try catch block.
 * This way if a Javascript error emerges from the wasm, we can escalate it to a
 * fatal error.
 *
 * This file to be included from pyproxy.c This uses the JS_FILE macro defined
 * in include_js_file.h
 */
// clang-format off
JS_FILE(pyproxy_init_js, () => {0,0; /* Magic, see include_js_file.h */
  Module.PyProxies = {};
  // clang-format on

  if (globalThis.FinalizationRegistry) {
    Module.finalizationRegistry = new FinalizationRegistry((ptr) => {
      try {
        _Py_DecRef(ptr);
      } catch (e) {
        // I'm not really sure what happens if an error occurs inside of a
        // finalizer...
        Module.fatal_error(e);
      }
    });
    // For some unclear reason this code screws up selenium FirefoxDriver. Works
    // fine in chrome and when I test it in browser. It seems to be sensitive to
    // changes that don't make a difference to the semantics.
    // TODO: after v0.17.0 release, fix selenium issues with this code.
    // Module.bufferFinalizationRegistry = new FinalizationRegistry((ptr) => {
    //   try {
    //     _PyBuffer_Release(ptr);
    //     _PyMem_Free(ptr);
    //   } catch (e) {
    //     Module.fatal_error(e);
    //   }
    // });
  } else {
    Module.finalizationRegistry = {register() {}, unregister() {}};
    // Module.bufferFinalizationRegistry = finalizationRegistry;
  }

  /**
   * In the case that the Python object is callable, PyProxyClass inherits from
   * Function so that PyProxy objects can be callable.
   *
   * The following properties on a Python object will be shadowed in the proxy
   * in the case that the Python object is callable:
   *  - "arguments" and
   *  - "caller"
   *
   * Inheriting from Function has the unfortunate side effect that we MUST
   * expose the members "proxy.arguments" and "proxy.caller" because they are
   * nonconfigurable, nonwritable, nonenumerable own properties. They are just
   * always `null`.
   *
   * We also get the properties "length" and "name" which are configurable so we
   * delete them in the constructor. "prototype" is not configurable so we can't
   * delete it, however it *is* writable so we set it to be undefined. We must
   * still make "prototype in proxy" be true though.
   * @private
   */
  Module.pyproxy_new = function(ptrobj) {
    let flags = _pyproxy_getflags(ptrobj);
    let cls = Module.getPyProxyClass(flags);
    // Reflect.construct calls the constructor of Module.PyProxyClass but sets
    // the prototype as cls.prototype. This gives us a way to dynamically create
    // subclasses of PyProxyClass (as long as we don't need to use the "new
    // cls(ptrobj)" syntax).
    let target;
    if (flags & IS_CALLABLE) {
      // To make a callable proxy, we must call the Function constructor.
      // In this case we are effectively subclassing Function.
      target = Reflect.construct(Function, [], cls);
      // Remove undesirable properties added by Function constructor. Note: we
      // can't remove "arguments" or "caller" because they are not configurable
      // and not writable
      delete target.length;
      delete target.name;
      // prototype isn't configurable so we can't delete it but it's writable.
      target.prototype = undefined;
    } else {
      target = Object.create(cls.prototype);
    }
    Object.defineProperty(target, "$$",
                          {value : {ptr : ptrobj, type : 'PyProxy'}});
    _Py_IncRef(ptrobj);
    let proxy = new Proxy(target, Module.PyProxyHandlers);
    Module.finalizationRegistry.register(proxy, ptrobj, proxy);
    return proxy;
  };

  function _getPtr(jsobj) {
    let ptr = jsobj.$$.ptr;
    if (ptr === null) {
      throw new Error("Object has already been destroyed");
    }
    return ptr;
  }

  let _pyproxyClassMap = new Map();
  /**
   * Retreive the appropriate mixins based on the features requested in flags.
   * Used by pyproxy_new. The "flags" variable is produced by the C function
   * pyproxy_getflags. Multiple PyProxies with the same set of feature flags
   * will share the same prototype, so the memory footprint of each individual
   * PyProxy is minimal.
   * @private
   */
  Module.getPyProxyClass = function(flags) {
    let result = _pyproxyClassMap.get(flags);
    if (result) {
      return result;
    }
    let descriptors = {};
    // clang-format off
    for(let [feature_flag, methods] of [
      [HAS_LENGTH, Module.PyProxyLengthMethods],
      [HAS_GET, Module.PyProxyGetItemMethods],
      [HAS_SET, Module.PyProxySetItemMethods],
      [HAS_CONTAINS, Module.PyProxyContainsMethods],
      [IS_ITERABLE, Module.PyProxyIterableMethods],
      [IS_ITERATOR, Module.PyProxyIteratorMethods],
      [IS_AWAITABLE, Module.PyProxyAwaitableMethods],
      [IS_BUFFER, Module.PyProxyBufferMethods],
      [IS_CALLABLE, Module.PyProxyCallableMethods],
    ]){
      // clang-format on
      if (flags & feature_flag) {
        Object.assign(descriptors, Object.getOwnPropertyDescriptors(methods));
      }
    }
    let new_proto = Object.create(Module.PyProxyClass.prototype, descriptors);
    function PyProxy() {};
    PyProxy.prototype = new_proto;
    _pyproxyClassMap.set(flags, PyProxy);
    return PyProxy;
  };

  // Static methods
  Module.PyProxy_getPtr = _getPtr;

  // Now a lot of boilerplate to wrap the abstract Object protocol wrappers
  // defined in pyproxy.c in Javascript functions.

  Module.callPyObject = function(ptrobj, ...jsargs) {
    let idargs = Module.hiwire.new_value(jsargs);
    let idresult;
    try {
      idresult = __pyproxy_apply(ptrobj, idargs);
    } catch (e) {
      Module.fatal_error(e);
    } finally {
      Module.hiwire.decref(idargs);
    }
    if (idresult === 0) {
      _pythonexc2js();
    }
    return Module.hiwire.pop_value(idresult);
  };

  Module.PyProxyClass = class {
    constructor() { throw new TypeError('PyProxy is not a constructor'); }

    get[Symbol.toStringTag]() { return "PyProxy"; }
    /**
     * The name of the type of the object.
     *
     * Usually the value is ``"module.name"`` but for builtins or
     * interpreter-defined types it is just ``"name"``. As pseudocode this is:
     *
     * .. code-block:: python
     *
     *    ty = type(x)
     *    if ty.__module__ == 'builtins' or ty.__module__ == "__main__":
     *        return ty.__name__
     *    else:
     *        ty.__module__ + "." + ty.__name__
     *
     */
    get type() {
      let ptrobj = _getPtr(this);
      return Module.hiwire.pop_value(__pyproxy_type(ptrobj));
    }
    toString() {
      let ptrobj = _getPtr(this);
      let jsref_repr;
      try {
        jsref_repr = __pyproxy_repr(ptrobj);
      } catch (e) {
        Module.fatal_error(e);
      }
      if (jsref_repr === 0) {
        _pythonexc2js();
      }
      return Module.hiwire.pop_value(jsref_repr);
    }
    /**
     * Destroy the ``PyProxy``. This will release the memory. Any further
     * attempt to use the object will raise an error.
     *
     * In a browser supporting `FinalizationRegistry
     * <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry>`_
     * Pyodide will automatically destroy the ``PyProxy`` when it is garbage
     * collected, however there is no guarantee that the finalizer will be run
     * in a timely manner so it is better to ``destory`` the proxy explicitly.
     */
    destroy() {
      let ptrobj = _getPtr(this);
      Module.finalizationRegistry.unregister(this);
      // Maybe the destructor will call Javascript code that will somehow try
      // to use this proxy. Mark it deleted before decrementing reference count
      // just in case!
      this.$$.ptr = null;
      try {
        _Py_DecRef(ptrobj);
      } catch (e) {
        Module.fatal_error(e);
      }
    }
    /**
     * Converts the ``PyProxy`` into a Javascript object as best as possible. By
     * default does a deep conversion, if a shallow conversion is desired, you
     * can use ``proxy.toJs(1)``.
     * See :ref:`Explicit Conversion of PyProxy
     * <type-translations-pyproxy-to-js>` for more info.
     *
     * @param {number} depth How many layers deep to perform the conversion.
     * Defaults to infinite.
     * @returns The Javascript object resulting from the conversion.
     */
    toJs(depth = -1) {
      let ptrobj = _getPtr(this);
      let idresult;
      try {
        idresult = _python2js_with_depth(ptrobj, depth);
      } catch (e) {
        Module.fatal_error(e);
      }
      if (idresult === 0) {
        _pythonexc2js();
      }
      return Module.hiwire.pop_value(idresult);
    }
    apply(jsthis, jsargs) {
      return Module.callPyObject(_getPtr(this), ...jsargs);
    }
    call(jsthis, ...jsargs) {
      return Module.callPyObject(_getPtr(this), ...jsargs);
    }
  };

  // Controlled by HAS_LENGTH, appears for any object with __len__ or sq_length
  // or mp_length methods
  Module.PyProxyLengthMethods = {
    /**
     * The length of the object.
     *
     * Present only if the proxied Python object has a ``__len__`` method.
     */
    get length() {
      let ptrobj = _getPtr(this);
      let length;
      try {
        length = _PyObject_Size(ptrobj);
      } catch (e) {
        Module.fatal_error(e);
      }
      if (length === -1) {
        _pythonexc2js();
      }
      return length;
    }
  };

  // Controlled by HAS_GET, appears for any class with __getitem__,
  // mp_subscript, or sq_item methods
  Module.PyProxyGetItemMethods = {
    /**
     * This translates to the Python code ``obj[key]``.
     *
     * Present only if the proxied Python object has a ``__getitem__`` method.
     *
     * @param {any} key The key to look up.
     * @returns The corresponding value.
     */
    get : function(key) {
      let ptrobj = _getPtr(this);
      let idkey = Module.hiwire.new_value(key);
      let idresult;
      try {
        idresult = __pyproxy_getitem(ptrobj, idkey);
      } catch (e) {
        Module.fatal_error(e);
      } finally {
        Module.hiwire.decref(idkey);
      }
      if (idresult === 0) {
        if (Module._PyErr_Occurred()) {
          _pythonexc2js();
        } else {
          return undefined;
        }
      }
      return Module.hiwire.pop_value(idresult);
    },
  };

  // Controlled by HAS_SET, appears for any class with __setitem__, __delitem__,
  // mp_ass_subscript,  or sq_ass_item.
  Module.PyProxySetItemMethods = {
    /**
     * This translates to the Python code ``obj[key] = value``.
     *
     * Present only if the proxied Python object has a ``__setitem__`` method.
     *
     * @param {any} key The key to set.
     * @param {any} value The value to set it to.
     */
    set : function(key, value) {
      let ptrobj = _getPtr(this);
      let idkey = Module.hiwire.new_value(key);
      let idval = Module.hiwire.new_value(value);
      let errcode;
      try {
        errcode = __pyproxy_setitem(ptrobj, idkey, idval);
      } catch (e) {
        Module.fatal_error(e);
      } finally {
        Module.hiwire.decref(idkey);
        Module.hiwire.decref(idval);
      }
      if (errcode === -1) {
        _pythonexc2js();
      }
    },
    /**
     * This translates to the Python code ``del obj[key]``.
     *
     * Present only if the proxied Python object has a ``__delitem__`` method.
     *
     * @param {any} key The key to delete.
     */
    delete : function(key) {
      let ptrobj = _getPtr(this);
      let idkey = Module.hiwire.new_value(key);
      let errcode;
      try {
        errcode = __pyproxy_delitem(ptrobj, idkey);
      } catch (e) {
        Module.fatal_error(e);
      } finally {
        Module.hiwire.decref(idkey);
      }
      if (errcode === -1) {
        _pythonexc2js();
      }
    }
  };

  // Controlled by HAS_CONTAINS flag, appears for any class with __contains__ or
  // sq_contains
  Module.PyProxyContainsMethods = {
    /**
     * This translates to the Python code ``key in obj``.
     *
     * Present only if the proxied Python object has a ``__contains__`` method.
     *
     * @param {*} key The key to check for.
     * @returns {bool} Is ``key`` present?
     */
    has : function(key) {
      let ptrobj = _getPtr(this);
      let idkey = Module.hiwire.new_value(key);
      let result;
      try {
        result = __pyproxy_contains(ptrobj, idkey);
      } catch (e) {
        Module.fatal_error(e);
      } finally {
        Module.hiwire.decref(idkey);
      }
      if (result === -1) {
        _pythonexc2js();
      }
      return result === 1;
    },
  };

  class TempError extends Error {};

  /**
   * A helper for [Symbol.iterator].
   *
   * Because "it is possible for a generator to be garbage collected without
   * ever running its finally block", we take extra care to try to ensure that
   * we don't leak the iterator. We register it with the finalizationRegistry,
   * but if the finally block is executed, we decref the pointer and unregister.
   *
   * In order to do this, we create the generator with this inner method,
   * register the finalizer, and then return it.
   *
   * Quote from:
   * https://hacks.mozilla.org/2015/07/es6-in-depth-generators-continued/
   *
   * @private
   */
  function* iter_helper(iterptr, token) {
    try {
      if (iterptr === 0) {
        throw new TempError();
      }
      let item;
      while ((item = __pyproxy_iter_next(iterptr))) {
        yield Module.hiwire.pop_value(item);
      }
      if (_PyErr_Occurred()) {
        throw new TempError();
      }
    } catch (e) {
      if (e instanceof TempError) {
        _pythonexc2js();
      } else {
        Module.fatal_error(e);
      }
    } finally {
      Module.finalizationRegistry.unregister(token);
      _Py_DecRef(iterptr);
    }
  }

  // Controlled by IS_ITERABLE, appears for any object with __iter__ or tp_iter,
  // unless they are iterators. See: https://docs.python.org/3/c-api/iter.html
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols
  // This avoids allocating a PyProxy wrapper for the temporary iterator.
  Module.PyProxyIterableMethods = {
    /**
     * This translates to the Python code ``iter(obj)``. Return an iterator
     * associated to the proxy. See the documentation for `Symbol.iterator
     * <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/iterator>`_.
     *
     * Present only if the proxied Python object is iterable (i.e., has an
     * ``__iter__`` method).
     *
     * This will be used implicitly by ``for(let x of proxy){}``.
     *
     * @returns {Iterator} An iterator for the proxied Python object.
     */
    [Symbol.iterator] : function() {
      let ptrobj = _getPtr(this);
      let token = {};
      let iterptr;
      try {
        iterptr = _PyObject_GetIter(ptrobj);
      } catch (e) {
        Module.fatal_error(e);
      }

      let result = iter_helper(iterptr, token);
      Module.finalizationRegistry.register(result, iterptr, token);
      return result;
    },
  };

  // Controlled by IS_ITERATOR, appears for any object with a __next__ or
  // tp_iternext method.
  Module.PyProxyIteratorMethods = {
    [Symbol.iterator] : function() { return this; },
    /**
     * This translates to the Python code ``next(obj)``. Returns the next value
     * of the generator. See the documentation for `Generator.prototype.next
     * <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator/next>`_.
     * The argument will be sent to the Python generator.
     *
     * This will be used implicitly by ``for(let x of proxy){}``.
     *
     * Present only if the proxied Python object is a generator or iterator
     * (i.e., has a ``send`` or ``__next__`` method).
     *
     * @param {*} value The value to send to the generator. The value will be
     * assigned as a result of a yield expression.
     * @returns {Object} An Object with two properties: ``done`` and ``value``.
     * When the generator yields ``some_value``, ``next`` returns ``{done :
     * false, value : some_value}``. When the generator raises a
     * ``StopIteration(result_value)`` exception, ``next`` returns ``{done :
     * true, value : result_value}``.
     */
    next : function(arg) {
      let idresult;
      // Note: arg is optional, if arg is not supplied, it will be undefined
      // which gets converted to "Py_None". This is as intended.
      let idarg = Module.hiwire.new_value(arg);
      let done;
      try {
        idresult = __pyproxyGen_Send(_getPtr(this), idarg);
        done = idresult === 0;
        if (done) {
          idresult = __pyproxyGen_FetchStopIterationValue();
        }
      } catch (e) {
        Module.fatal_error(e);
      } finally {
        Module.hiwire.decref(idarg);
      }
      if (done && idresult === 0) {
        _pythonexc2js();
      }
      let value = Module.hiwire.pop_value(idresult);
      return {done, value};
    },
  };

  // Another layer of boilerplate. The PyProxyHandlers have some annoying logic
  // to deal with straining out the spurious "Function" properties "prototype",
  // "arguments", and "length", to deal with correctly satisfying the Proxy
  // invariants, and to deal with the mro
  function python_hasattr(jsobj, jskey) {
    let ptrobj = _getPtr(jsobj);
    let idkey = Module.hiwire.new_value(jskey);
    let result;
    try {
      result = __pyproxy_hasattr(ptrobj, idkey);
    } catch (e) {
      Module.fatal_error(e);
    } finally {
      Module.hiwire.decref(idkey);
    }
    if (result === -1) {
      _pythonexc2js();
    }
    return result !== 0;
  }

  // Returns a JsRef in order to allow us to differentiate between "not found"
  // (in which case we return 0) and "found 'None'" (in which case we return
  // Js_undefined).
  function python_getattr(jsobj, jskey) {
    let ptrobj = _getPtr(jsobj);
    let idkey = Module.hiwire.new_value(jskey);
    let idresult;
    try {
      idresult = __pyproxy_getattr(ptrobj, idkey);
    } catch (e) {
      Module.fatal_error(e);
    } finally {
      Module.hiwire.decref(idkey);
    }
    if (idresult === 0) {
      if (_PyErr_Occurred()) {
        _pythonexc2js();
      }
    }
    return idresult;
  }

  function python_setattr(jsobj, jskey, jsval) {
    let ptrobj = _getPtr(jsobj);
    let idkey = Module.hiwire.new_value(jskey);
    let idval = Module.hiwire.new_value(jsval);
    let errcode;
    try {
      errcode = __pyproxy_setattr(ptrobj, idkey, idval);
    } catch (e) {
      Module.fatal_error(e);
    } finally {
      Module.hiwire.decref(idkey);
      Module.hiwire.decref(idval);
    }
    if (errcode === -1) {
      _pythonexc2js();
    }
  }

  function python_delattr(jsobj, jskey) {
    let ptrobj = _getPtr(jsobj);
    let idkey = Module.hiwire.new_value(jskey);
    let errcode;
    try {
      errcode = __pyproxy_delattr(ptrobj, idkey);
    } catch (e) {
      Module.fatal_error(e);
    } finally {
      Module.hiwire.decref(idkey);
    }
    if (errcode === -1) {
      _pythonexc2js();
    }
  }

  // See explanation of which methods should be defined here and what they do
  // here:
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
  Module.PyProxyHandlers = {
    isExtensible : function() { return true },
    has : function(jsobj, jskey) {
      // Note: must report "prototype" in proxy when we are callable.
      // (We can return the wrong value from "get" handler though.)
      let objHasKey = Reflect.has(jsobj, jskey);
      if (objHasKey) {
        return true;
      }
      // python_hasattr will crash when given a Symbol.
      if (typeof (jskey) === "symbol") {
        return false;
      }
      return python_hasattr(jsobj, jskey);
    },
    get : function(jsobj, jskey) {
      // Preference order:
      // 1. things we have to return to avoid making Javascript angry
      // 2. the result of Python getattr
      // 3. stuff from the prototype chain

      // 1. things we have to return to avoid making Javascript angry
      // This conditional looks funky but it's the only thing I found that
      // worked right in all cases.
      if ((jskey in jsobj) && !(jskey in Object.getPrototypeOf(jsobj))) {
        return Reflect.get(jsobj, jskey);
      }
      // python_getattr will crash when given a Symbol
      if (typeof (jskey) === "symbol") {
        return Reflect.get(jsobj, jskey);
      }
      // 2. The result of getattr
      let idresult = python_getattr(jsobj, jskey);
      if (idresult !== 0) {
        return Module.hiwire.pop_value(idresult);
      }
      // 3. stuff from the prototype chain.
      return Reflect.get(jsobj, jskey);
    },
    set : function(jsobj, jskey, jsval) {
      // We're only willing to set properties on the python object, throw an
      // error if user tries to write over any key of type 1. things we have to
      // return to avoid making Javascript angry
      if (typeof (jskey) === "symbol") {
        throw new TypeError(
            `Cannot set read only field '${jskey.description}'`);
      }
      // Again this is a funny looking conditional, I found it as the result of
      // a lengthy search for something that worked right.
      let descr = Object.getOwnPropertyDescriptor(jsobj, jskey);
      if (descr && !descr.writable) {
        throw new TypeError(`Cannot set read only field '${jskey}'`);
      }
      python_setattr(jsobj, jskey, jsval);
      return true;
    },
    deleteProperty : function(jsobj, jskey) {
      // We're only willing to delete properties on the python object, throw an
      // error if user tries to write over any key of type 1. things we have to
      // return to avoid making Javascript angry
      if (typeof (jskey) === "symbol") {
        throw new TypeError(
            `Cannot delete read only field '${jskey.description}'`);
      }
      let descr = Object.getOwnPropertyDescriptor(jsobj, jskey);
      if (descr && !descr.writable) {
        throw new TypeError(`Cannot delete read only field '${jskey}'`);
      }
      python_delattr(jsobj, jskey);
      // Must return "false" if "jskey" is a nonconfigurable own property.
      // Otherwise Javascript will throw a TypeError.
      return !descr || descr.configurable;
    },
    ownKeys : function(jsobj) {
      let ptrobj = _getPtr(jsobj);
      let idresult;
      try {
        idresult = __pyproxy_ownKeys(ptrobj);
      } catch (e) {
        Module.fatal_error(e);
      }
      if (idresult === 0) {
        _pythonexc2js();
      }
      let result = Module.hiwire.pop_value(idresult);
      result.push(...Reflect.ownKeys(jsobj));
      return result;
    },
    // clang-format off
    apply : function(jsobj, jsthis, jsargs) {
      return jsobj.apply(jsthis, jsargs);
    },
    // clang-format on
  };

  /**
   * The Promise / javascript awaitable API.
   * @private
   */
  Module.PyProxyAwaitableMethods = {
    /**
     * This wraps __pyproxy_ensure_future and makes a function that converts a
     * Python awaitable to a promise, scheduling the awaitable on the Python
     * event loop if necessary.
     * @private
     */
    _ensure_future : function() {
      let ptrobj = _getPtr(this);
      let resolveHandle;
      let rejectHandle;
      let promise = new Promise((resolve, reject) => {
        resolveHandle = resolve;
        rejectHandle = reject;
      });
      let resolve_handle_id = Module.hiwire.new_value(resolveHandle);
      let reject_handle_id = Module.hiwire.new_value(rejectHandle);
      let errcode;
      try {
        errcode = __pyproxy_ensure_future(ptrobj, resolve_handle_id,
                                          reject_handle_id);
      } catch (e) {
        Module.fatal_error(e);
      } finally {
        Module.hiwire.decref(reject_handle_id);
        Module.hiwire.decref(resolve_handle_id);
      }
      if (errcode === -1) {
        _pythonexc2js();
      }
      return promise;
    },
    /**
     * Runs ``asyncio.ensure_future(awaitable)``, executes
     * ``onFulfilled(result)`` when the ``Future`` resolves successfully,
     * executes ``onRejected(error)`` when the ``Future`` fails. Will be used
     * implictly by ``await obj``.
     *
     * See the documentation for
     * `Promise.then
     * <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/then>`_
     *
     * Present only if the proxied Python object is `awaitable
     * <https://docs.python.org/3/library/asyncio-task.html?highlight=awaitable#awaitables>`_.
     *
     * @param {Function} onFulfilled A handler called with the result as an
     * argument if the awaitable succeeds.
     * @param {Function} onRejected A handler called with the error as an
     * argument if the awaitable fails.
     * @returns {Promise} The resulting Promise.
     */
    then : function(onFulfilled, onRejected) {
      let promise = this._ensure_future();
      return promise.then(onFulfilled, onRejected);
    },
    /**
     * Runs ``asyncio.ensure_future(awaitable)`` and executes
     * ``onRejected(error)`` if the future fails.
     *
     * See the documentation for
     * `Promise.catch
     * <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/catch>`_.
     *
     * Present only if the proxied Python object is `awaitable
     * <https://docs.python.org/3/library/asyncio-task.html?highlight=awaitable#awaitables>`_.
     *
     * @param {Function} onRejected A handler called with the error as an
     * argument if the awaitable fails.
     * @returns {Promise} The resulting Promise.
     */
    catch : function(onRejected) {
      let promise = this._ensure_future();
      return promise.catch(onRejected);
    },
    /**
     * Runs ``asyncio.ensure_future(awaitable)`` and executes
     * ``onFinally(error)`` when the future resolves.
     *
     * See the documentation for
     * `Promise.finally
     * <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/finally>`_.
     *
     * Present only if the proxied Python object is `awaitable
     * <https://docs.python.org/3/library/asyncio-task.html?highlight=awaitable#awaitables>`_.
     *
     *
     * @param {Function} onFinally A handler that is called with zero arguments
     * when the awaitable resolves.
     * @returns {Promise} A Promise that resolves or rejects with the same
     * result as the original Promise, but only after executing the
     * ``onFinally`` handler.
     */
    finally : function(onFinally) {
      let promise = this._ensure_future();
      return promise.finally(onFinally);
    }
  };

  Module.PyProxyCallableMethods = {prototype : Function.prototype};

  // clang-format off
  let type_to_array_map = new Map([
    [ "i8", Int8Array ],
    [ "u8", Uint8Array ],
    [ "u8clamped", Uint8ClampedArray ],
    [ "i16", Int16Array ],
    [ "u16", Uint16Array ],
    [ "i32", Int32Array ],
    [ "u32", Uint32Array ],
    [ "i32", Int32Array ],
    [ "u32", Uint32Array ],
    // if these aren't available, will be globalThis.BigInt64Array will be
    // undefined rather than raising a ReferenceError.
    [ "i64", globalThis.BigInt64Array],
    [ "u64", globalThis.BigUint64Array],
    [ "f32", Float32Array ],
    [ "f64", Float64Array ],
    [ "dataview", DataView ],
  ]);
  // clang-format on

  Module.PyProxyBufferMethods = {
    /**
     * Get a view of the buffer data which is usable from Javascript. No copy is
     * ever performed.
     *
     * Present only if the proxied Python object supports the `Python Buffer
     * Protocol <https://docs.python.org/3/c-api/buffer.html>`_.
     *
     * We do not support suboffsets, if the buffer requires suboffsets we will
     * throw an error. Javascript nd array libraries can't handle suboffsets
     * anyways. In this case, you should use the :any:`toJs` api or copy the
     * buffer to one that doesn't use suboffets (using e.g.,
     * `numpy.ascontiguousarray
     * <https://numpy.org/doc/stable/reference/generated/numpy.ascontiguousarray.html>`_).
     *
     * If the buffer stores big endian data or half floats, this function will
     * fail without an explicit type argument. For big endian data you can use
     * ``toJs``. `DataViews
     * <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DataView>`_
     * have support for big endian data, so you might want to pass
     * ``'dataview'`` as the type argument in that case.
     *
     * @param {string} [type] The type of :any:`PyBuffer.data` field in the
     * output. Should be one of: ``"i8"``, ``"u8"``, ``"u8clamped"``, ``"i16"``,
     * ``"u16"``, ``"i32"``, ``"u32"``, ``"i32"``, ``"u32"``, ``"i64"``,
     * ``"u64"``, ``"f32"``, ``"f64``, or ``"dataview"``. This argument is
     * optional, if absent ``getBuffer`` will try to determine the appropriate
     * output type based on the buffer `format string
     * <https://docs.python.org/3/library/struct.html#format-strings>`_.
     * @returns :any:`PyBuffer`
     */
    getBuffer : function(type) {
      let ArrayType = undefined;
      if (type) {
        ArrayType = type_to_array_map.get(type);
        if (ArrayType === undefined) {
          throw new Error(`Unknown type ${type}`);
        }
      }
      let this_ptr = _getPtr(this);
      let buffer_struct_ptr;
      try {
        buffer_struct_ptr = __pyproxy_get_buffer(this_ptr);
      } catch (e) {
        Module.fatal_error(e);
      }
      if (buffer_struct_ptr === 0) {
        _pythonexc2js();
      }

      // This has to match the order of the fields in buffer_struct
      let cur_ptr = buffer_struct_ptr / 4;

      let startByteOffset = HEAP32[cur_ptr++];
      let minByteOffset = HEAP32[cur_ptr++];
      let maxByteOffset = HEAP32[cur_ptr++];

      let readonly = !!HEAP32[cur_ptr++];
      let format_ptr = HEAP32[cur_ptr++];
      let itemsize = HEAP32[cur_ptr++];
      let shape = Module.hiwire.pop_value(HEAP32[cur_ptr++]);
      let strides = Module.hiwire.pop_value(HEAP32[cur_ptr++]);

      let view_ptr = HEAP32[cur_ptr++];
      let c_contiguous = !!HEAP32[cur_ptr++];
      let f_contiguous = !!HEAP32[cur_ptr++];

      let format = UTF8ToString(format_ptr);
      try {
        _PyMem_Free(buffer_struct_ptr);
      } catch (e) {
        Module.fatal_error(e);
      }

      let success = false;
      try {
        let bigEndian = false;
        if (ArrayType === undefined) {
          [ArrayType, bigEndian] = Module.processBufferFormatString(
              format, " In this case, you can pass an explicit type argument.");
        }
        let alignment =
            parseInt(ArrayType.name.replace(/[^0-9]/g, "")) / 8 || 1;
        if (bigEndian && alignment > 1) {
          throw new Error(
              "Javascript has no native support for big endian buffers. " +
              "In this case, you can pass an explicit type argument. " +
              "For instance, `getBuffer('dataview')` will return a `DataView`" +
              "which has native support for reading big endian data." +
              "Alternatively, toJs will automatically convert the buffer " +
              "to little endian.");
        }
        let numBytes = maxByteOffset - minByteOffset;
        if (numBytes !== 0 && (startByteOffset % alignment !== 0 ||
                               minByteOffset % alignment !== 0 ||
                               maxByteOffset % alignment !== 0)) {
          throw new Error(
              `Buffer does not have valid alignment for a ${ArrayType.name}`);
        }
        let numEntries = numBytes / alignment;
        let offset = (startByteOffset - minByteOffset) / alignment;
        let data;
        if (numBytes === 0) {
          data = new ArrayType();
        } else {
          data = new ArrayType(HEAP8.buffer, minByteOffset, numEntries);
        }
        for (let i of strides.keys()) {
          strides[i] /= alignment;
        }

        success = true;
        // clang-format off
        let result = Object.create(Module.PyBuffer.prototype,
          Object.getOwnPropertyDescriptors({
            offset,
            readonly,
            format,
            itemsize,
            ndim : shape.length,
            nbytes : numBytes,
            shape,
            strides,
            data,
            c_contiguous,
            f_contiguous,
            _view_ptr : view_ptr,
            _released : false
          })
        );
        // Module.bufferFinalizationRegistry.register(result, view_ptr, result);
        return result;
        // clang-format on
      } finally {
        if (!success) {
          try {
            _PyBuffer_Release(view_ptr);
            _PyMem_Free(view_ptr);
          } catch (e) {
            Module.fatal_error(e);
          }
        }
      }
    }
  };

  // clang-format off
  /**
   * A class to allow access to a Python data buffers from Javascript. These are
   * produced by :any:`PyProxy.getBuffer` and cannot be constructed directly.
   * When you are done, release it with the :any:`release <PyBuffer.release>`
   * method.  See
   * `Python buffer protocol documentation
   * <https://docs.python.org/3/c-api/buffer.html>`_ for more information.
   *
   * To find the element ``x[a_1, ..., a_n]``, you could use the following code:
   *
   * .. code-block:: js
   *
   *    function multiIndexToIndex(pybuff, multiIndex){
   *       if(multindex.length !==pybuff.ndim){
   *          throw new Error("Wrong length index");
   *       }
   *       let idx = pybuff.offset;
   *       for(let i = 0; i < pybuff.ndim; i++){
   *          if(multiIndex[i] < 0){
   *             multiIndex[i] = pybuff.shape[i] - multiIndex[i];
   *          }
   *          if(multiIndex[i] < 0 || multiIndex[i] >= pybuff.shape[i]){
   *             throw new Error("Index out of range");
   *          }
   *          idx += multiIndex[i] * pybuff.stride[i];
   *       }
   *       return idx;
   *    }
   *    console.log("entry is", pybuff.data[multiIndexToIndex(pybuff, [2, 0, -1])]);
   *
   * .. admonition:: Contiguity
   *    :class: warning
   *
   *    If the buffer is not contiguous, the ``data`` TypedArray will contain
   *    data that is not part of the buffer. Modifying this data may lead to
   *    undefined behavior.
   *
   * .. admonition:: Readonly buffers
   *    :class: warning
   *
   *    If ``buffer.readonly`` is ``true``, you should not modify the buffer.
   *    Modifying a readonly buffer may lead to undefined behavior.
   *
   * .. admonition:: Converting between TypedArray types
   *    :class: warning
   *
   *    The following naive code to change the type of a typed array does not
   *    work:
   *
   *    .. code-block:: js
   *
   *        // Incorrectly convert a TypedArray.
   *        // Produces a Uint16Array that points to the entire WASM memory!
   *        let myarray = new Uint16Array(buffer.data.buffer);
   *
   *    Instead, if you want to convert the output TypedArray, you need to say:
   *
   *    .. code-block:: js
   *
   *        // Correctly convert a TypedArray.
   *        let myarray = new Uint16Array(
   *            buffer.data.buffer,
   *            buffer.data.byteOffset,
   *            buffer.data.byteLength
   *        );
   */
  // clang-format on
  Module.PyBuffer = class PyBuffer {
    constructor() {
      // FOR_JSDOC_ONLY is a macro that deletes its argument.
      FOR_JSDOC_ONLY(() => {
        /**
         * The offset of the first entry of the array. For instance if our array
         * is 3d, then you will find ``array[0,0,0]`` at
         * ``pybuf.data[pybuf.offset]``
         * @type {number}
         */
        this.offset;

        /**
         * If the data is readonly, you should not modify it. There is no way
         * for us to enforce this, but it may cause very weird behavior.
         * @type {boolean}
         */
        this.readonly;

        /**
         * The format string for the buffer. See `the Python documentation on
         * format strings
         * <https://docs.python.org/3/library/struct.html#format-strings>`_.
         * @type {string}
         */
        this.format;

        /**
         * How large is each entry (in bytes)?
         * @type {number}
         */
        this.itemsize;

        /**
         * The number of dimensions of the buffer. If ``ndim`` is 0, the buffer
         * represents a single scalar or struct. Otherwise, it represents an
         * array.
         * @type {number}
         */
        this.ndim;

        /**
         * The total number of bytes the buffer takes up. This is equal to
         * ``buff.data.byteLength``.
         * @type {number}
         */
        this.nbytes;

        /**
         * The shape of the buffer, that is how long it is in each dimension.
         * The length will be equal to ``ndim``. For instance, a 2x3x4 array
         * would have shape ``[2, 3, 4]``.
         * @type {number[]}
         */
        this.shape;

        /**
         * An array of of length ``ndim`` giving the number of elements to skip
         * to get to a new element in each dimension. See the example definition
         * of a ``multiIndexToIndex`` function above.
         * @type {number[]}
         */
        this.strides;

        /**
         * The actual data. A typed array of an appropriate size backed by a
         * segment of the WASM memory.
         *
         * The ``type`` argument of :any:`getBuffer`
         * determines which sort of `TypedArray` this is, by default
         * :any:`getBuffer` will look at the format string to determine the most
         * appropriate option.
         * @type {TypedArray}
         */
        this.data;

        /**
         * Is it C contiguous?
         * @type {boolean}
         */
        this.c_contiguous;

        /**
         * Is it Fortran contiguous?
         * @type {boolean}
         */
        this.f_contiguous;
      });
      throw new TypeError('PyBuffer is not a constructor');
    }

    /**
     * Release the buffer. This allows the memory to be reclaimed.
     */
    release() {
      if (this._released) {
        return;
      }
      // Module.bufferFinalizationRegistry.unregister(this);
      try {
        _PyBuffer_Release(this._view_ptr);
        _PyMem_Free(this._view_ptr);
      } catch (e) {
        Module.fatal_error(e);
      }
      this._released = true;
      this.data = null;
    }
  };

  // A special proxy that we use to wrap pyodide.globals to allow property
  // access like `pyodide.globals.x`.
  let globalsPropertyAccessWarned = false;
  let globalsPropertyAccessWarningMsg =
      "Access to pyodide.globals via pyodide.globals.key is deprecated and " +
      "will be removed in version 0.18.0. Use pyodide.globals.get('key'), " +
      "pyodide.globals.set('key', value), pyodide.globals.delete('key') instead.";
  let NamespaceProxyHandlers = {
    // clang-format off
    has : function(obj, key) {
      return Reflect.has(obj, key) || obj.has(key);
    },
    // clang-format on
    get : function(obj, key) {
      if (Reflect.has(obj, key)) {
        return Reflect.get(obj, key);
      }
      let result = obj.get(key);
      if (!globalsPropertyAccessWarned && result !== undefined) {
        console.warn(globalsPropertyAccessWarningMsg);
        globalsPropertyAccessWarned = true;
      }
      return result;
    },
    set : function(obj, key, value) {
      if (Reflect.has(obj, key)) {
        throw new Error(`Cannot set read only field ${key}`);
      }
      if (!globalsPropertyAccessWarned) {
        globalsPropertyAccessWarned = true;
        console.warn(globalsPropertyAccessWarningMsg);
      }
      obj.set(key, value);
    },
    ownKeys : function(obj) {
      let result = new Set(Reflect.ownKeys(obj));
      let iter = obj.keys();
      for (let key of iter) {
        result.add(key);
      }
      iter.destroy();
      return Array.from(result);
    }
  };

  // clang-format off
  Module.wrapNamespace = function wrapNamespace(ns) {
    return new Proxy(ns, NamespaceProxyHandlers);
  };
  // clang-format on
  return 0;
});
