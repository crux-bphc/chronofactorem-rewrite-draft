import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Router,
  RouterProvider,
  rootRouteWithContext,
} from "@tanstack/react-router";
import React from "react";
import { CookiesProvider } from "react-cookie";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import aboutRoute from "./About";
import authenticatedRoute from "./AuthenticatedRoute";
import NotFound from "./components/NotFound";
import editTimetableRoute from "./EditTimetable";
import editUserProfileRoute from "./EditUserProfile";
import finalizeTimetableRoute from "./FinalizeTimetable";
import getDegreesRoute from "./GetDegrees";
import homeRoute from "./Home";
import loginRoute from "./Login";
import RootComponent from "./RootComponent";
import searchRoute from "./SearchResults";
import viewTimetableRoute from "./ViewTimetable";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

export const rootRoute = rootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootComponent,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  getDegreesRoute,
  aboutRoute,
  authenticatedRoute.addChildren([
    homeRoute,
    editUserProfileRoute,
    editTimetableRoute,
    finalizeTimetableRoute,
    viewTimetableRoute,
    searchRoute,
  ]),
]);

export const router = new Router({
  routeTree,
  // defaultPreload: "intent",
  // Since we're using React Query, we don't want loader calls to ever be stale
  // This will ensure that the loader is always called when the route is preloaded or visited
  defaultPreloadStaleTime: 0,
  context: {
    queryClient,
  },
  defaultNotFoundComponent: NotFound,
});

// Register things for typesafety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
        <CookiesProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </CookiesProvider>
      </ThemeProvider>
    </React.StrictMode>,
  );
}
