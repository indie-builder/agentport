UPDATE "knowledge_documents" SET "title" = left("title", 300) WHERE char_length("title") > 300;
