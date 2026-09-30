import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/chat" });
  },
  component: function IndexRedirect() {
    return <Navigate to="/chat" replace />;
  },
});

