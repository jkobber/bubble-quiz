import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { updateQuestion } from "@/app/[locale]/(app)/admin/actions"; 
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { redirect } from "@/i18n/routing";
import { getTranslations } from 'next-intl/server';
import { QuestionForm } from "@/app/[locale]/(app)/questions/question-form";
import { notFound } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { AuditLogViewer } from "@/components/quiz/audit-log-viewer";

interface Props {
  params: Promise<{ id: string }>
}

export default async function EditQuestionPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect({ href: "/api/auth/signin", locale: "en" });
    return null; // TS satisfaction
  }

  const question = await db.question.findUnique({
    where: { id },
    include: {
      tags: {
        include: { tag: true }, // -> question.tags is [{ tag: { name } }, ...]
      },
      collections: {
        include: { collection: true }, // optional: falls du Checkboxen für Collections anzeigen willst
      },
    },
  });

  if (!question) notFound();

  // Check access permissions (Owner, Admin, or Unlocked)
  const isOwner = question.creatorId === session.user.id
  const isAdmin = session.user.role === "ADMIN"
  const canEdit = isOwner || isAdmin || !question.isLocked

  if (!canEdit) {
      redirect({ href: "/questions", locale: "en" });
  }

  const t = await getTranslations("Admin");

  // Fetch audit logs
  const logs = await db.questionEditLog.findMany({
    where: { questionId: id },
    include: { 
        user: {
            select: { name: true, username: true, image: true } 
        } 
    },
    orderBy: { timestamp: 'desc' }
  });

  const initialData = {
    id: question.id,
    text: question.text,
    options: JSON.parse(question.options),
    correctIndex: question.correctIndex,
    category: question.category ?? undefined,
    tags: question.tags?.map((t: any) => t.tag?.name).filter(Boolean) ?? [],
    collectionIds: question.collections?.map((c: any) => c.collection?.id).filter(Boolean) ?? [],
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-8 flex justify-center">
      <div className="w-full max-w-2xl space-y-8">
        
        <div className="flex justify-between items-center">
          <div className="flex gap-4 items-center">
             <BackButton />
             <h1 className="text-3xl font-bold bg-gradient-to-r from-purple-400 to-blue-500 bg-clip-text text-transparent">
                Edit Question
             </h1>
          </div>
        </div>

        <Card className="bg-card border-border shadow-xl">
          <CardHeader>
            <CardTitle>Edit Question</CardTitle>
          </CardHeader>
          <CardContent>
            <QuestionForm 
              initialData={initialData}
              onSubmit={updateQuestion} 
              title="Edit Question"
              submitLabel="Save Changes"
              availableCollections={question.collections?.map((c: any) => ({ id: c.collection.id, name: c.collection.name })) ?? []}
            />
          </CardContent>
        </Card>

        {/* Audit Log */}
        <Card className="bg-card border-border shadow-md">
             <CardContent className="pt-6">
                 <AuditLogViewer logs={logs} />
             </CardContent>
        </Card>

      </div>
    </div>
  );
}
