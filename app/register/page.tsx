import { AuthForm } from "@/features/auth/components/AuthForm";

export const metadata = { title: "Create account — SpotLens" };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
