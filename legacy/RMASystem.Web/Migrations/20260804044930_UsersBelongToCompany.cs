using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class UsersBelongToCompany : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AppUsers_UserName",
                table: "AppUsers");

            migrationBuilder.RenameColumn(
                name: "DefaultCompanyId",
                table: "AppUsers",
                newName: "CompanyId");

            // Fail closed: every user must point at a real company before FK
            migrationBuilder.Sql("""
                IF NOT EXISTS (SELECT 1 FROM Companies WHERE Id = 1)
                BEGIN
                    SET IDENTITY_INSERT Companies ON;
                    INSERT INTO Companies (Id, Code, Name, InvoicePrefix, TicketPrefix, IsActive, CreatedAt)
                    VALUES (1, N'INF', N'INFINITE SOLUTIONS', N'IS-GST-2627-', N'INF', 1, GETDATE());
                    SET IDENTITY_INSERT Companies OFF;
                END
                UPDATE AppUsers SET CompanyId = 1 WHERE CompanyId IS NULL OR CompanyId <= 0
                    OR NOT EXISTS (SELECT 1 FROM Companies c WHERE c.Id = AppUsers.CompanyId);
                """);

            migrationBuilder.CreateIndex(
                name: "IX_AppUsers_CompanyId_UserName",
                table: "AppUsers",
                columns: new[] { "CompanyId", "UserName" },
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "FK_AppUsers_Companies_CompanyId",
                table: "AppUsers",
                column: "CompanyId",
                principalTable: "Companies",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_AppUsers_Companies_CompanyId",
                table: "AppUsers");

            migrationBuilder.DropIndex(
                name: "IX_AppUsers_CompanyId_UserName",
                table: "AppUsers");

            migrationBuilder.RenameColumn(
                name: "CompanyId",
                table: "AppUsers",
                newName: "DefaultCompanyId");

            migrationBuilder.CreateIndex(
                name: "IX_AppUsers_UserName",
                table: "AppUsers",
                column: "UserName",
                unique: true);
        }
    }
}
