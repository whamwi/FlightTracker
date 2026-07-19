/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(() => {
var exports = {};
exports.id = "app/api/airspace/route";
exports.ids = ["app/api/airspace/route"];
exports.modules = {

/***/ "(rsc)/./app/api/airspace/route.ts":
/*!***********************************!*\
  !*** ./app/api/airspace/route.ts ***!
  \***********************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   GET: () => (/* binding */ GET),\n/* harmony export */   dynamic: () => (/* binding */ dynamic)\n/* harmony export */ });\n/* harmony import */ var next_server__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! next/server */ \"(rsc)/./node_modules/next/dist/api/server.js\");\n\nconst dynamic = 'force-dynamic';\n// Centre of IST→DXB corridor; 900 nm radius covers both endpoints\nconst FEEDS = [\n    'https://opendata.adsb.fi/api/v2/lat/33.0/lon/42.0/dist/900',\n    'https://api.adsb.lol/v2/lat/33.0/lon/42.0/dist/900'\n];\nlet cache = null;\nlet inflight = null;\nasync function fetchFeed() {\n    for (const url of FEEDS){\n        try {\n            const res = await fetch(url, {\n                headers: {\n                    'User-Agent': 'FlightTracker/1.0'\n                },\n                signal: AbortSignal.timeout(8000)\n            });\n            if (!res.ok) continue;\n            const json = await res.json();\n            // eslint-disable-next-line @typescript-eslint/no-explicit-any\n            return (json.ac ?? []).filter((a)=>a.lat != null && a.lon != null);\n        } catch  {}\n    }\n    throw new Error('all feeds failed');\n}\nasync function GET() {\n    try {\n        if (cache && Date.now() - cache.ts < 10000) {\n            return next_server__WEBPACK_IMPORTED_MODULE_0__.NextResponse.json({\n                ok: true,\n                aircraft: cache.aircraft,\n                ts: cache.ts\n            });\n        }\n        if (!inflight) {\n            inflight = fetchFeed().then((aircraft)=>{\n                cache = {\n                    aircraft,\n                    ts: Date.now()\n                };\n                return aircraft;\n            }).finally(()=>{\n                inflight = null;\n            });\n        }\n        const aircraft = await inflight;\n        return next_server__WEBPACK_IMPORTED_MODULE_0__.NextResponse.json({\n            ok: true,\n            aircraft,\n            ts: cache.ts\n        });\n    } catch (err) {\n        const fallback = cache?.aircraft ?? [];\n        return next_server__WEBPACK_IMPORTED_MODULE_0__.NextResponse.json({\n            ok: true,\n            aircraft: fallback,\n            ts: cache?.ts ?? 0,\n            warn: String(err)\n        });\n    }\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHJzYykvLi9hcHAvYXBpL2FpcnNwYWNlL3JvdXRlLnRzIiwibWFwcGluZ3MiOiI7Ozs7OztBQUEwQztBQUVuQyxNQUFNQyxVQUFVLGdCQUFlO0FBRXRDLGtFQUFrRTtBQUNsRSxNQUFNQyxRQUFRO0lBQ1o7SUFDQTtDQUNEO0FBRUQsSUFBSUMsUUFBb0Q7QUFDeEQsSUFBSUMsV0FBc0M7QUFFMUMsZUFBZUM7SUFDYixLQUFLLE1BQU1DLE9BQU9KLE1BQU87UUFDdkIsSUFBSTtZQUNGLE1BQU1LLE1BQU0sTUFBTUMsTUFBTUYsS0FBSztnQkFDM0JHLFNBQVM7b0JBQUUsY0FBYztnQkFBb0I7Z0JBQzdDQyxRQUFRQyxZQUFZQyxPQUFPLENBQUM7WUFDOUI7WUFDQSxJQUFJLENBQUNMLElBQUlNLEVBQUUsRUFBRTtZQUNiLE1BQU1DLE9BQU8sTUFBTVAsSUFBSU8sSUFBSTtZQUMzQiw4REFBOEQ7WUFDOUQsT0FBTyxDQUFDQSxLQUFLQyxFQUFFLElBQUksRUFBRSxFQUFFQyxNQUFNLENBQUMsQ0FBQ0MsSUFBV0EsRUFBRUMsR0FBRyxJQUFJLFFBQVFELEVBQUVFLEdBQUcsSUFBSTtRQUN0RSxFQUFFLE9BQU0sQ0FBaUI7SUFDM0I7SUFDQSxNQUFNLElBQUlDLE1BQU07QUFDbEI7QUFFTyxlQUFlQztJQUNwQixJQUFJO1FBQ0YsSUFBSWxCLFNBQVNtQixLQUFLQyxHQUFHLEtBQUtwQixNQUFNcUIsRUFBRSxHQUFHLE9BQVE7WUFDM0MsT0FBT3hCLHFEQUFZQSxDQUFDYyxJQUFJLENBQUM7Z0JBQUVELElBQUk7Z0JBQU1ZLFVBQVV0QixNQUFNc0IsUUFBUTtnQkFBRUQsSUFBSXJCLE1BQU1xQixFQUFFO1lBQUM7UUFDOUU7UUFDQSxJQUFJLENBQUNwQixVQUFVO1lBQ2JBLFdBQVdDLFlBQ1JxQixJQUFJLENBQUNELENBQUFBO2dCQUFjdEIsUUFBUTtvQkFBRXNCO29CQUFVRCxJQUFJRixLQUFLQyxHQUFHO2dCQUFHO2dCQUFHLE9BQU9FO1lBQVMsR0FDekVFLE9BQU8sQ0FBQztnQkFBUXZCLFdBQVc7WUFBSztRQUNyQztRQUNBLE1BQU1xQixXQUFXLE1BQU1yQjtRQUN2QixPQUFPSixxREFBWUEsQ0FBQ2MsSUFBSSxDQUFDO1lBQUVELElBQUk7WUFBTVk7WUFBVUQsSUFBSXJCLE1BQU9xQixFQUFFO1FBQUM7SUFDL0QsRUFBRSxPQUFPSSxLQUFLO1FBQ1osTUFBTUMsV0FBVzFCLE9BQU9zQixZQUFZLEVBQUU7UUFDdEMsT0FBT3pCLHFEQUFZQSxDQUFDYyxJQUFJLENBQUM7WUFBRUQsSUFBSTtZQUFNWSxVQUFVSTtZQUFVTCxJQUFJckIsT0FBT3FCLE1BQU07WUFBR00sTUFBTUMsT0FBT0g7UUFBSztJQUNqRztBQUNGIiwic291cmNlcyI6WyIvVXNlcnMvd2Fzc2ltL0ZsaWdodFRyYWNrZXIvYXBwL2FwaS9haXJzcGFjZS9yb3V0ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBOZXh0UmVzcG9uc2UgfSBmcm9tICduZXh0L3NlcnZlcidcblxuZXhwb3J0IGNvbnN0IGR5bmFtaWMgPSAnZm9yY2UtZHluYW1pYydcblxuLy8gQ2VudHJlIG9mIElTVOKGkkRYQiBjb3JyaWRvcjsgOTAwIG5tIHJhZGl1cyBjb3ZlcnMgYm90aCBlbmRwb2ludHNcbmNvbnN0IEZFRURTID0gW1xuICAnaHR0cHM6Ly9vcGVuZGF0YS5hZHNiLmZpL2FwaS92Mi9sYXQvMzMuMC9sb24vNDIuMC9kaXN0LzkwMCcsXG4gICdodHRwczovL2FwaS5hZHNiLmxvbC92Mi9sYXQvMzMuMC9sb24vNDIuMC9kaXN0LzkwMCcsXG5dXG5cbmxldCBjYWNoZTogeyBhaXJjcmFmdDogdW5rbm93bltdOyB0czogbnVtYmVyIH0gfCBudWxsID0gbnVsbFxubGV0IGluZmxpZ2h0OiBQcm9taXNlPHVua25vd25bXT4gfCBudWxsID0gbnVsbFxuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEZlZWQoKTogUHJvbWlzZTx1bmtub3duW10+IHtcbiAgZm9yIChjb25zdCB1cmwgb2YgRkVFRFMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7XG4gICAgICAgIGhlYWRlcnM6IHsgJ1VzZXItQWdlbnQnOiAnRmxpZ2h0VHJhY2tlci8xLjAnIH0sXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg4MDAwKSxcbiAgICAgIH0pXG4gICAgICBpZiAoIXJlcy5vaykgY29udGludWVcbiAgICAgIGNvbnN0IGpzb24gPSBhd2FpdCByZXMuanNvbigpXG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuICAgICAgcmV0dXJuIChqc29uLmFjID8/IFtdKS5maWx0ZXIoKGE6IGFueSkgPT4gYS5sYXQgIT0gbnVsbCAmJiBhLmxvbiAhPSBudWxsKVxuICAgIH0gY2F0Y2ggeyAvKiB0cnkgbmV4dCAqLyB9XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKCdhbGwgZmVlZHMgZmFpbGVkJylcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIEdFVCgpIHtcbiAgdHJ5IHtcbiAgICBpZiAoY2FjaGUgJiYgRGF0ZS5ub3coKSAtIGNhY2hlLnRzIDwgMTBfMDAwKSB7XG4gICAgICByZXR1cm4gTmV4dFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYWlyY3JhZnQ6IGNhY2hlLmFpcmNyYWZ0LCB0czogY2FjaGUudHMgfSlcbiAgICB9XG4gICAgaWYgKCFpbmZsaWdodCkge1xuICAgICAgaW5mbGlnaHQgPSBmZXRjaEZlZWQoKVxuICAgICAgICAudGhlbihhaXJjcmFmdCA9PiB7IGNhY2hlID0geyBhaXJjcmFmdCwgdHM6IERhdGUubm93KCkgfTsgcmV0dXJuIGFpcmNyYWZ0IH0pXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHsgaW5mbGlnaHQgPSBudWxsIH0pXG4gICAgfVxuICAgIGNvbnN0IGFpcmNyYWZ0ID0gYXdhaXQgaW5mbGlnaHRcbiAgICByZXR1cm4gTmV4dFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYWlyY3JhZnQsIHRzOiBjYWNoZSEudHMgfSlcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgZmFsbGJhY2sgPSBjYWNoZT8uYWlyY3JhZnQgPz8gW11cbiAgICByZXR1cm4gTmV4dFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYWlyY3JhZnQ6IGZhbGxiYWNrLCB0czogY2FjaGU/LnRzID8/IDAsIHdhcm46IFN0cmluZyhlcnIpIH0pXG4gIH1cbn1cbiJdLCJuYW1lcyI6WyJOZXh0UmVzcG9uc2UiLCJkeW5hbWljIiwiRkVFRFMiLCJjYWNoZSIsImluZmxpZ2h0IiwiZmV0Y2hGZWVkIiwidXJsIiwicmVzIiwiZmV0Y2giLCJoZWFkZXJzIiwic2lnbmFsIiwiQWJvcnRTaWduYWwiLCJ0aW1lb3V0Iiwib2siLCJqc29uIiwiYWMiLCJmaWx0ZXIiLCJhIiwibGF0IiwibG9uIiwiRXJyb3IiLCJHRVQiLCJEYXRlIiwibm93IiwidHMiLCJhaXJjcmFmdCIsInRoZW4iLCJmaW5hbGx5IiwiZXJyIiwiZmFsbGJhY2siLCJ3YXJuIiwiU3RyaW5nIl0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VSb290IjoiIn0=\n//# sourceURL=webpack-internal:///(rsc)/./app/api/airspace/route.ts\n");

/***/ }),

/***/ "(rsc)/./node_modules/next/dist/build/webpack/loaders/next-app-loader/index.js?name=app%2Fapi%2Fairspace%2Froute&page=%2Fapi%2Fairspace%2Froute&appPaths=&pagePath=private-next-app-dir%2Fapi%2Fairspace%2Froute.ts&appDir=%2FUsers%2Fwassim%2FFlightTracker%2Fapp&pageExtensions=tsx&pageExtensions=ts&pageExtensions=jsx&pageExtensions=js&rootDir=%2FUsers%2Fwassim%2FFlightTracker&isDev=true&tsconfigPath=tsconfig.json&basePath=&assetPrefix=&nextConfigOutput=&preferredRegion=&middlewareConfig=e30%3D!":
/*!****************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************!*\
  !*** ./node_modules/next/dist/build/webpack/loaders/next-app-loader/index.js?name=app%2Fapi%2Fairspace%2Froute&page=%2Fapi%2Fairspace%2Froute&appPaths=&pagePath=private-next-app-dir%2Fapi%2Fairspace%2Froute.ts&appDir=%2FUsers%2Fwassim%2FFlightTracker%2Fapp&pageExtensions=tsx&pageExtensions=ts&pageExtensions=jsx&pageExtensions=js&rootDir=%2FUsers%2Fwassim%2FFlightTracker&isDev=true&tsconfigPath=tsconfig.json&basePath=&assetPrefix=&nextConfigOutput=&preferredRegion=&middlewareConfig=e30%3D! ***!
  \****************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

"use strict";
eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   patchFetch: () => (/* binding */ patchFetch),\n/* harmony export */   routeModule: () => (/* binding */ routeModule),\n/* harmony export */   serverHooks: () => (/* binding */ serverHooks),\n/* harmony export */   workAsyncStorage: () => (/* binding */ workAsyncStorage),\n/* harmony export */   workUnitAsyncStorage: () => (/* binding */ workUnitAsyncStorage)\n/* harmony export */ });\n/* harmony import */ var next_dist_server_route_modules_app_route_module_compiled__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! next/dist/server/route-modules/app-route/module.compiled */ \"(rsc)/./node_modules/next/dist/server/route-modules/app-route/module.compiled.js\");\n/* harmony import */ var next_dist_server_route_modules_app_route_module_compiled__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(next_dist_server_route_modules_app_route_module_compiled__WEBPACK_IMPORTED_MODULE_0__);\n/* harmony import */ var next_dist_server_route_kind__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! next/dist/server/route-kind */ \"(rsc)/./node_modules/next/dist/server/route-kind.js\");\n/* harmony import */ var next_dist_server_lib_patch_fetch__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! next/dist/server/lib/patch-fetch */ \"(rsc)/./node_modules/next/dist/server/lib/patch-fetch.js\");\n/* harmony import */ var next_dist_server_lib_patch_fetch__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(next_dist_server_lib_patch_fetch__WEBPACK_IMPORTED_MODULE_2__);\n/* harmony import */ var _Users_wassim_FlightTracker_app_api_airspace_route_ts__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./app/api/airspace/route.ts */ \"(rsc)/./app/api/airspace/route.ts\");\n\n\n\n\n// We inject the nextConfigOutput here so that we can use them in the route\n// module.\nconst nextConfigOutput = \"\"\nconst routeModule = new next_dist_server_route_modules_app_route_module_compiled__WEBPACK_IMPORTED_MODULE_0__.AppRouteRouteModule({\n    definition: {\n        kind: next_dist_server_route_kind__WEBPACK_IMPORTED_MODULE_1__.RouteKind.APP_ROUTE,\n        page: \"/api/airspace/route\",\n        pathname: \"/api/airspace\",\n        filename: \"route\",\n        bundlePath: \"app/api/airspace/route\"\n    },\n    resolvedPagePath: \"/Users/wassim/FlightTracker/app/api/airspace/route.ts\",\n    nextConfigOutput,\n    userland: _Users_wassim_FlightTracker_app_api_airspace_route_ts__WEBPACK_IMPORTED_MODULE_3__\n});\n// Pull out the exports that we need to expose from the module. This should\n// be eliminated when we've moved the other routes to the new format. These\n// are used to hook into the route.\nconst { workAsyncStorage, workUnitAsyncStorage, serverHooks } = routeModule;\nfunction patchFetch() {\n    return (0,next_dist_server_lib_patch_fetch__WEBPACK_IMPORTED_MODULE_2__.patchFetch)({\n        workAsyncStorage,\n        workUnitAsyncStorage\n    });\n}\n\n\n//# sourceMappingURL=app-route.js.map//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHJzYykvLi9ub2RlX21vZHVsZXMvbmV4dC9kaXN0L2J1aWxkL3dlYnBhY2svbG9hZGVycy9uZXh0LWFwcC1sb2FkZXIvaW5kZXguanM/bmFtZT1hcHAlMkZhcGklMkZhaXJzcGFjZSUyRnJvdXRlJnBhZ2U9JTJGYXBpJTJGYWlyc3BhY2UlMkZyb3V0ZSZhcHBQYXRocz0mcGFnZVBhdGg9cHJpdmF0ZS1uZXh0LWFwcC1kaXIlMkZhcGklMkZhaXJzcGFjZSUyRnJvdXRlLnRzJmFwcERpcj0lMkZVc2VycyUyRndhc3NpbSUyRkZsaWdodFRyYWNrZXIlMkZhcHAmcGFnZUV4dGVuc2lvbnM9dHN4JnBhZ2VFeHRlbnNpb25zPXRzJnBhZ2VFeHRlbnNpb25zPWpzeCZwYWdlRXh0ZW5zaW9ucz1qcyZyb290RGlyPSUyRlVzZXJzJTJGd2Fzc2ltJTJGRmxpZ2h0VHJhY2tlciZpc0Rldj10cnVlJnRzY29uZmlnUGF0aD10c2NvbmZpZy5qc29uJmJhc2VQYXRoPSZhc3NldFByZWZpeD0mbmV4dENvbmZpZ091dHB1dD0mcHJlZmVycmVkUmVnaW9uPSZtaWRkbGV3YXJlQ29uZmlnPWUzMCUzRCEiLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7QUFBK0Y7QUFDdkM7QUFDcUI7QUFDSztBQUNsRjtBQUNBO0FBQ0E7QUFDQSx3QkFBd0IseUdBQW1CO0FBQzNDO0FBQ0EsY0FBYyxrRUFBUztBQUN2QjtBQUNBO0FBQ0E7QUFDQTtBQUNBLEtBQUs7QUFDTDtBQUNBO0FBQ0EsWUFBWTtBQUNaLENBQUM7QUFDRDtBQUNBO0FBQ0E7QUFDQSxRQUFRLHNEQUFzRDtBQUM5RDtBQUNBLFdBQVcsNEVBQVc7QUFDdEI7QUFDQTtBQUNBLEtBQUs7QUFDTDtBQUMwRjs7QUFFMUYiLCJzb3VyY2VzIjpbIiJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBcHBSb3V0ZVJvdXRlTW9kdWxlIH0gZnJvbSBcIm5leHQvZGlzdC9zZXJ2ZXIvcm91dGUtbW9kdWxlcy9hcHAtcm91dGUvbW9kdWxlLmNvbXBpbGVkXCI7XG5pbXBvcnQgeyBSb3V0ZUtpbmQgfSBmcm9tIFwibmV4dC9kaXN0L3NlcnZlci9yb3V0ZS1raW5kXCI7XG5pbXBvcnQgeyBwYXRjaEZldGNoIGFzIF9wYXRjaEZldGNoIH0gZnJvbSBcIm5leHQvZGlzdC9zZXJ2ZXIvbGliL3BhdGNoLWZldGNoXCI7XG5pbXBvcnQgKiBhcyB1c2VybGFuZCBmcm9tIFwiL1VzZXJzL3dhc3NpbS9GbGlnaHRUcmFja2VyL2FwcC9hcGkvYWlyc3BhY2Uvcm91dGUudHNcIjtcbi8vIFdlIGluamVjdCB0aGUgbmV4dENvbmZpZ091dHB1dCBoZXJlIHNvIHRoYXQgd2UgY2FuIHVzZSB0aGVtIGluIHRoZSByb3V0ZVxuLy8gbW9kdWxlLlxuY29uc3QgbmV4dENvbmZpZ091dHB1dCA9IFwiXCJcbmNvbnN0IHJvdXRlTW9kdWxlID0gbmV3IEFwcFJvdXRlUm91dGVNb2R1bGUoe1xuICAgIGRlZmluaXRpb246IHtcbiAgICAgICAga2luZDogUm91dGVLaW5kLkFQUF9ST1VURSxcbiAgICAgICAgcGFnZTogXCIvYXBpL2FpcnNwYWNlL3JvdXRlXCIsXG4gICAgICAgIHBhdGhuYW1lOiBcIi9hcGkvYWlyc3BhY2VcIixcbiAgICAgICAgZmlsZW5hbWU6IFwicm91dGVcIixcbiAgICAgICAgYnVuZGxlUGF0aDogXCJhcHAvYXBpL2FpcnNwYWNlL3JvdXRlXCJcbiAgICB9LFxuICAgIHJlc29sdmVkUGFnZVBhdGg6IFwiL1VzZXJzL3dhc3NpbS9GbGlnaHRUcmFja2VyL2FwcC9hcGkvYWlyc3BhY2Uvcm91dGUudHNcIixcbiAgICBuZXh0Q29uZmlnT3V0cHV0LFxuICAgIHVzZXJsYW5kXG59KTtcbi8vIFB1bGwgb3V0IHRoZSBleHBvcnRzIHRoYXQgd2UgbmVlZCB0byBleHBvc2UgZnJvbSB0aGUgbW9kdWxlLiBUaGlzIHNob3VsZFxuLy8gYmUgZWxpbWluYXRlZCB3aGVuIHdlJ3ZlIG1vdmVkIHRoZSBvdGhlciByb3V0ZXMgdG8gdGhlIG5ldyBmb3JtYXQuIFRoZXNlXG4vLyBhcmUgdXNlZCB0byBob29rIGludG8gdGhlIHJvdXRlLlxuY29uc3QgeyB3b3JrQXN5bmNTdG9yYWdlLCB3b3JrVW5pdEFzeW5jU3RvcmFnZSwgc2VydmVySG9va3MgfSA9IHJvdXRlTW9kdWxlO1xuZnVuY3Rpb24gcGF0Y2hGZXRjaCgpIHtcbiAgICByZXR1cm4gX3BhdGNoRmV0Y2goe1xuICAgICAgICB3b3JrQXN5bmNTdG9yYWdlLFxuICAgICAgICB3b3JrVW5pdEFzeW5jU3RvcmFnZVxuICAgIH0pO1xufVxuZXhwb3J0IHsgcm91dGVNb2R1bGUsIHdvcmtBc3luY1N0b3JhZ2UsIHdvcmtVbml0QXN5bmNTdG9yYWdlLCBzZXJ2ZXJIb29rcywgcGF0Y2hGZXRjaCwgIH07XG5cbi8vIyBzb3VyY2VNYXBwaW5nVVJMPWFwcC1yb3V0ZS5qcy5tYXAiXSwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlUm9vdCI6IiJ9\n//# sourceURL=webpack-internal:///(rsc)/./node_modules/next/dist/build/webpack/loaders/next-app-loader/index.js?name=app%2Fapi%2Fairspace%2Froute&page=%2Fapi%2Fairspace%2Froute&appPaths=&pagePath=private-next-app-dir%2Fapi%2Fairspace%2Froute.ts&appDir=%2FUsers%2Fwassim%2FFlightTracker%2Fapp&pageExtensions=tsx&pageExtensions=ts&pageExtensions=jsx&pageExtensions=js&rootDir=%2FUsers%2Fwassim%2FFlightTracker&isDev=true&tsconfigPath=tsconfig.json&basePath=&assetPrefix=&nextConfigOutput=&preferredRegion=&middlewareConfig=e30%3D!\n");

/***/ }),

/***/ "(rsc)/./node_modules/next/dist/build/webpack/loaders/next-flight-client-entry-loader.js?server=true!":
/*!******************************************************************************************************!*\
  !*** ./node_modules/next/dist/build/webpack/loaders/next-flight-client-entry-loader.js?server=true! ***!
  \******************************************************************************************************/
/***/ (() => {



/***/ }),

/***/ "(ssr)/./node_modules/next/dist/build/webpack/loaders/next-flight-client-entry-loader.js?server=true!":
/*!******************************************************************************************************!*\
  !*** ./node_modules/next/dist/build/webpack/loaders/next-flight-client-entry-loader.js?server=true! ***!
  \******************************************************************************************************/
/***/ (() => {



/***/ }),

/***/ "../app-render/after-task-async-storage.external":
/*!***********************************************************************************!*\
  !*** external "next/dist/server/app-render/after-task-async-storage.external.js" ***!
  \***********************************************************************************/
/***/ ((module) => {

"use strict";
module.exports = require("next/dist/server/app-render/after-task-async-storage.external.js");

/***/ }),

/***/ "../app-render/work-async-storage.external":
/*!*****************************************************************************!*\
  !*** external "next/dist/server/app-render/work-async-storage.external.js" ***!
  \*****************************************************************************/
/***/ ((module) => {

"use strict";
module.exports = require("next/dist/server/app-render/work-async-storage.external.js");

/***/ }),

/***/ "./work-unit-async-storage.external":
/*!**********************************************************************************!*\
  !*** external "next/dist/server/app-render/work-unit-async-storage.external.js" ***!
  \**********************************************************************************/
/***/ ((module) => {

"use strict";
module.exports = require("next/dist/server/app-render/work-unit-async-storage.external.js");

/***/ }),

/***/ "next/dist/compiled/next-server/app-page.runtime.dev.js":
/*!*************************************************************************!*\
  !*** external "next/dist/compiled/next-server/app-page.runtime.dev.js" ***!
  \*************************************************************************/
/***/ ((module) => {

"use strict";
module.exports = require("next/dist/compiled/next-server/app-page.runtime.dev.js");

/***/ }),

/***/ "next/dist/compiled/next-server/app-route.runtime.dev.js":
/*!**************************************************************************!*\
  !*** external "next/dist/compiled/next-server/app-route.runtime.dev.js" ***!
  \**************************************************************************/
/***/ ((module) => {

"use strict";
module.exports = require("next/dist/compiled/next-server/app-route.runtime.dev.js");

/***/ })

};
;

// load runtime
var __webpack_require__ = require("../../../webpack-runtime.js");
__webpack_require__.C(exports);
var __webpack_exec__ = (moduleId) => (__webpack_require__(__webpack_require__.s = moduleId))
var __webpack_exports__ = __webpack_require__.X(0, ["vendor-chunks/next"], () => (__webpack_exec__("(rsc)/./node_modules/next/dist/build/webpack/loaders/next-app-loader/index.js?name=app%2Fapi%2Fairspace%2Froute&page=%2Fapi%2Fairspace%2Froute&appPaths=&pagePath=private-next-app-dir%2Fapi%2Fairspace%2Froute.ts&appDir=%2FUsers%2Fwassim%2FFlightTracker%2Fapp&pageExtensions=tsx&pageExtensions=ts&pageExtensions=jsx&pageExtensions=js&rootDir=%2FUsers%2Fwassim%2FFlightTracker&isDev=true&tsconfigPath=tsconfig.json&basePath=&assetPrefix=&nextConfigOutput=&preferredRegion=&middlewareConfig=e30%3D!")));
module.exports = __webpack_exports__;

})();