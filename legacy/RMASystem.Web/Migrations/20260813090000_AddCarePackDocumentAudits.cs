using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class AddCarePackDocumentAudits : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Idempotent: Single User (or a prior run) may already have this table
            // on the same RMASystem DB. CREATE TABLE would fail with error 2714.
            migrationBuilder.Sql("""
                IF OBJECT_ID(N'dbo.CarePackDocumentAudits', N'U') IS NULL
                BEGIN
                    CREATE TABLE [CarePackDocumentAudits] (
                        [Id] int NOT NULL IDENTITY,
                        [CarePackBatchId] int NOT NULL,
                        [Action] nvarchar(40) NOT NULL,
                        [Snapshot] nvarchar(max) NOT NULL,
                        [Reason] nvarchar(500) NOT NULL,
                        [Confirmed] bit NOT NULL,
                        [PerformedBy] nvarchar(100) NULL,
                        [PerformedAt] datetime NOT NULL,
                        CONSTRAINT [PK_CarePackDocumentAudits] PRIMARY KEY ([Id]),
                        CONSTRAINT [FK_CarePackDocumentAudits_CarePackBatches_CarePackBatchId]
                            FOREIGN KEY ([CarePackBatchId]) REFERENCES [CarePackBatches] ([Id]) ON DELETE CASCADE
                    );

                    CREATE INDEX [IX_CarePackDocumentAudits_CarePackBatchId_PerformedAt]
                        ON [CarePackDocumentAudits] ([CarePackBatchId], [PerformedAt]);
                END
                ELSE IF NOT EXISTS (
                    SELECT 1 FROM sys.indexes
                    WHERE name = N'IX_CarePackDocumentAudits_CarePackBatchId_PerformedAt'
                      AND object_id = OBJECT_ID(N'dbo.CarePackDocumentAudits')
                )
                BEGIN
                    CREATE INDEX [IX_CarePackDocumentAudits_CarePackBatchId_PerformedAt]
                        ON [CarePackDocumentAudits] ([CarePackBatchId], [PerformedAt]);
                END
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF OBJECT_ID(N'dbo.CarePackDocumentAudits', N'U') IS NOT NULL
                    DROP TABLE [CarePackDocumentAudits];
                """);
        }
    }
}
