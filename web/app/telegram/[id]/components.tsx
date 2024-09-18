"use client";

import { Progress } from "@/components/ui/progress";
import {
  CreateMLCEngine,
  InitProgressReport,
  MLCEngine,
} from "@mlc-ai/web-llm";
import { useEffect, useState } from "react";

export type ArticleHeadingProps = {
  body: string;
};

export function ArticleHeadingGenerator({ body }: ArticleHeadingProps) {
  const [engineLoadingProgress, setEngineLoadingProgress] =
    useState<InitProgressReport>();
  const [engine, setEngine] = useState<MLCEngine>();

  useEffect(() => {
    CreateMLCEngine("TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC", {
      initProgressCallback: setEngineLoadingProgress,
    }).then(setEngine);
  }, []);

  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    if (engine) {
      engine.chat.completions
        .create({
          messages: [
            { role: "system", content: "You are a helpful AI assistant." },
            {
              role: "user",
              content: `Come up with a better title for the following article: ${body}`,
            },
          ],
        })
        .then((output) => setTitle(output.choices[0].message.content));
    }
  }, [engine]);

  if (engineLoadingProgress) {
    return (
      <div className='flex flex-col'>
        <p className='font-mono'>
          {`Loading LLM: ${engineLoadingProgress.text} (${engineLoadingProgress.timeElapsed})`}
        </p>
        <Progress value={engineLoadingProgress.progress} />
      </div>
    );
  }

  if (!title) {
    return "Loading LLM Engine...";
  }

  return <h1 className='text-2xl font-bold dark:text-white'>{title}</h1>;
}
