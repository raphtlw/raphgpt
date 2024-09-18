import clsx from "clsx";
import rehypeDocument from "rehype-document";
import rehypeFormat from "rehype-format";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { sql } from "@vercel/postgres";

type TelegramPageProps = { params: { id: string } };

export default async function TelegramPage({ params }: TelegramPageProps) {
  const {rows} = await sql`SELECT * FROM telegram_pages WHERE id = ${params.id}`
  if (rows.length <= 0) return;
  const md = rows[0] as unknown as {
    id: string;
    title: string;
    content: string;
  };
  const processedContent = await unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeFormat)
    .use(rehypeDocument)
    .use(rehypePrettyCode)
    .use(rehypeStringify)
    .process(md.content);
  const contentHtml = processedContent.toString();

  return (
    <div className='flex flex-col items-center md:my-10'>
      <div className='flex flex-col gap-2 items-center mb-10'>
        <main className='flex flex-col gap-4 px-6 my-10 md:max-w-screen-lg'>
          {md.title && (
            <h1 className='text-2xl font-bold dark:text-white md:max-w-screen-sm'>
              {md.title}
            </h1>
          )}
          <div
            className={clsx(
              "prose dark:prose-invert",
              "prose-h1:font-bold prose-h1:text-xl",
              "prose-a:text-blue-600 prose-p:text-justify",
              "prose-img:rounded-xl prose-headings:underline",
              "prose-pre:overflow-auto prose-pre:max-w-[90vw]"
            )}
            dangerouslySetInnerHTML={{ __html: contentHtml }}
          ></div>
        </main>
      </div>
      <footer className='flex flex-col border-t dark:border-t-slate-700 dark:text-gray-400 px-6 md:px-0 py-6 w-full max-w-prose'>
        <p>Brought to you by raphGPT</p>
        <p>
          Developed by <a href='https://bento.me/raphtlw'>@raphtlw</a>
        </p>
      </footer>
    </div>
  );
}
