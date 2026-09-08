import { AuthForm } from "@/features/auth/components/AuthForm";

export const metadata = { title: "Sign in — SpotLens" };

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
