-- Articles: richer news posts (admin -> Articles, public /articles).
--
--   articles.summary    a short teaser for cards and lists (optional; without
--                       one, the start of the body is used)
--   articles.linkUrl    an external link shown as a button, e.g. the full
--   articles.linkLabel  newsletter on a flip-book site, with its label
--   article_images      extra photos shown as a gallery under the article,
--                       in order; removed with the article
--
-- Guarded so a retry after a partial run is harmless.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'articles' AND COLUMN_NAME = 'summary') = 0,
  'ALTER TABLE `articles` ADD COLUMN `summary` VARCHAR(300) NULL, ADD COLUMN `linkUrl` VARCHAR(500) NULL, ADD COLUMN `linkLabel` VARCHAR(100) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS `article_images` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `articleId` INTEGER NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `article_images_articleId_idx`(`articleId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'article_images' AND CONSTRAINT_NAME = 'article_images_articleId_fkey') = 0,
  'ALTER TABLE `article_images` ADD CONSTRAINT `article_images_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `articles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
