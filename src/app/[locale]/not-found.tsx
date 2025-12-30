import { Link } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  const t = useTranslations("NotFound");

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background p-4">
        {/* Background Gradients */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
        <div className="h-[500px] w-[500px] animate-pulse rounded-full bg-primary/20 blur-[100px]" />
        <div className="absolute -right-20 -top-20 h-96 w-96 rounded-full bg-blue-500/20 blur-[80px]" />
        <div className="absolute -bottom-20 -left-20 h-96 w-96 rounded-full bg-purple-500/20 blur-[80px]" />
      </div>

      <Card className="relative z-10 w-full max-w-md border-white/10 bg-white/5 p-8 text-center backdrop-blur-xl dark:border-white/5 dark:bg-black/20">
        <h1 className="mb-2 text-9xl font-black tracking-tighter text-primary/80">
          {t("title")}
        </h1>
        <h2 className="mb-6 text-2xl font-bold text-foreground">
          {t("message")}
        </h2>
        
        <Link href="/lobby">
          <Button size="lg" className="w-full font-bold">
            {t("return")}
          </Button>
        </Link>
      </Card>
    </div>
  );
}
