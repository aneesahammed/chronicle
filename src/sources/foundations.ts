import type { LearningMetadata } from "../types.ts";

export interface FoundationCourse {
  source_id: string;
  title: string;
  url: string;
  summary: string;
  // A small identity check rejects soft 404s/login pages; this is not a content review.
  expected_text: string;
  learning: LearningMetadata & {
    track: "foundations";
    publication_label: string;
    prerequisites: string;
    cost: string;
    reviewed_at: string;
    compatibility: string;
  };
}

// Curated from the linked first-party syllabus pages. Changing a review date requires
// reviewing the syllabus and prerequisites again. Fetching a page never advances it.
// No exact publication day was stated: the pipeline uses its explicit unknown-date
// sentinel, and the UI displays the original edition/precision below instead.
export const FOUNDATIONS: FoundationCourse[] = [
  {
    source_id: "learn_huggingface", title: "Hugging Face LLM Course",
    url: "https://huggingface.co/learn/llm-course/chapter1/1",
    expected_text: "good knowledge of Python",
    summary: "Learn Transformers, datasets and tokenizers through practical NLP exercises, model fine-tuning and shareable demos. Start here after an introductory deep-learning course.",
    learning: {
      track: "foundations", provider: "Hugging Face", level: "intermediate",
      publication_label: "Publication date not stated", prerequisites: "Good Python; introductory deep learning recommended",
      cost: "Free", reviewed_at: "2026-10-29", compatibility_status: "not_execution_tested",
      compatibility: "Follow the course's current environment setup. Example notebooks have not been run by Chronicle.",
    },
  },
  {
    source_id: "learn_huggingface", title: "Hugging Face Agents Course",
    url: "https://huggingface.co/learn/agents-course/unit0/introduction",
    expected_text: "Agents Course",
    summary: "Learn agent fundamentals, tool use and agent frameworks with hands-on assignments. Build and evaluate an agent through the course's practical units.",
    learning: {
      track: "foundations", provider: "Hugging Face", level: "intermediate",
      publication_label: "Publication date not stated", prerequisites: "Python and basic LLM knowledge",
      cost: "Free", reviewed_at: "2026-10-29", compatibility_status: "not_execution_tested",
      compatibility: "Agent frameworks change quickly; use each unit's current setup instructions. Examples have not been run by Chronicle.",
    },
  },
  {
    source_id: "learn_fullstack", title: "Full Stack Deep Learning: LLM Bootcamp",
    url: "https://fullstackdeeplearning.com/llm-bootcamp/",
    expected_text: "April 2023",
    summary: "Recorded lessons on LLM foundations, prompting, deployment, UX and augmented language models. Useful for product-building concepts; the original tooling is from 2023.",
    learning: {
      track: "foundations", provider: "Full Stack Deep Learning", level: "intermediate",
      publication_label: "April 2023 bootcamp", prerequisites: "Python; ML or web-development experience helpful",
      cost: "Free recordings and materials", reviewed_at: "2026-10-29", compatibility_status: "historical",
      compatibility: "The publisher warns that tools and model capabilities have evolved. Treat the code as historical; examples have not been run by Chronicle.",
    },
  },
  {
    source_id: "learn_fastai", title: "fast.ai: Practical Deep Learning for Coders",
    url: "https://course.fast.ai/", expected_text: "Practical Deep Learning for Coders",
    summary: "Nine practical lessons using PyTorch and fastai, covering computer vision, NLP, tabular data, recommendation and deployment. Includes exercises for learners with some coding experience.",
    learning: {
      track: "foundations", provider: "fast.ai", level: "beginner",
      publication_label: "2022 course · Part 1", prerequisites: "Some coding experience; no university mathematics required",
      cost: "Free", reviewed_at: "2026-10-29", compatibility_status: "historical",
      compatibility: "The lessons are the 2022 edition. Check the course's setup guidance before running notebooks; examples have not been run by Chronicle.",
    },
  },
];
