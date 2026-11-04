using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class PhaseB_CompaniesAndImportPlugins : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_RMATickets_InternalTicketNo",
                table: "RMATickets");

            migrationBuilder.DropIndex(
                name: "IX_MonthlyBatches_BatchId",
                table: "MonthlyBatches");

            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_InvoiceNumber_LineSetIndex",
                table: "CarePackBatches");

            migrationBuilder.CreateTable(
                name: "Companies",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Code = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    InvoicePrefix = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    TicketPrefix = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: false),
                    City = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    Address = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    ContactName = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    Email = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    Phone = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    ZohoBooksOrgId = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    ZohoDc = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: true),
                    ZohoClientId = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    ZohoClientSecret = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    ZohoBooksRefreshToken = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Companies", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Companies_Code",
                table: "Companies",
                column: "Code",
                unique: true);

            // Seed Infinite Solutions as Id=1 + Demo company for testing
            migrationBuilder.Sql("""
                SET IDENTITY_INSERT Companies ON;
                INSERT INTO Companies (Id, Code, Name, InvoicePrefix, TicketPrefix, City, Address, ContactName, Email, Phone, IsActive, CreatedAt)
                VALUES
                (1, N'INF', N'INFINITE SOLUTIONS', N'IS-GST-2627-', N'INF', N'New Delhi', N'312, VISHWADEEP TOWER', N'Sanjay Batra', N'sanjay@infinitesolutions.co.in', N'9311011467', 1, GETDATE()),
                (2, N'DEMO', N'Demo / Test Company', N'DEMO-INV-', N'DEMO', N'Test City', NULL, NULL, NULL, NULL, 1, GETDATE());
                SET IDENTITY_INSERT Companies OFF;
                """);

            migrationBuilder.AddColumn<int>(
                name: "CompanyId",
                table: "RMATickets",
                type: "int",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<int>(
                name: "CompanyId",
                table: "OemPaymentTransfers",
                type: "int",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<int>(
                name: "CompanyId",
                table: "MonthlyBatches",
                type: "int",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<int>(
                name: "CompanyId",
                table: "CarePackBatches",
                type: "int",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<int>(
                name: "DefaultCompanyId",
                table: "AppUsers",
                type: "int",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.Sql("""
                UPDATE RMATickets SET CompanyId = 1 WHERE CompanyId = 0 OR CompanyId IS NULL;
                UPDATE CarePackBatches SET CompanyId = 1 WHERE CompanyId = 0 OR CompanyId IS NULL;
                UPDATE MonthlyBatches SET CompanyId = 1 WHERE CompanyId = 0 OR CompanyId IS NULL;
                UPDATE OemPaymentTransfers SET CompanyId = 1 WHERE CompanyId = 0 OR CompanyId IS NULL;
                UPDATE AppUsers SET DefaultCompanyId = 1 WHERE DefaultCompanyId = 0 OR DefaultCompanyId IS NULL;
                """);

            migrationBuilder.CreateIndex(
                name: "IX_RMATickets_CompanyId_InternalTicketNo",
                table: "RMATickets",
                columns: new[] { "CompanyId", "InternalTicketNo" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_OemPaymentTransfers_CompanyId",
                table: "OemPaymentTransfers",
                column: "CompanyId");

            migrationBuilder.CreateIndex(
                name: "IX_MonthlyBatches_CompanyId_BatchId",
                table: "MonthlyBatches",
                columns: new[] { "CompanyId", "BatchId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_CompanyId_InvoiceNumber_LineSetIndex",
                table: "CarePackBatches",
                columns: new[] { "CompanyId", "InvoiceNumber", "LineSetIndex" },
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "FK_CarePackBatches_Companies_CompanyId",
                table: "CarePackBatches",
                column: "CompanyId",
                principalTable: "Companies",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_MonthlyBatches_Companies_CompanyId",
                table: "MonthlyBatches",
                column: "CompanyId",
                principalTable: "Companies",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_OemPaymentTransfers_Companies_CompanyId",
                table: "OemPaymentTransfers",
                column: "CompanyId",
                principalTable: "Companies",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_RMATickets_Companies_CompanyId",
                table: "RMATickets",
                column: "CompanyId",
                principalTable: "Companies",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_CarePackBatches_Companies_CompanyId",
                table: "CarePackBatches");

            migrationBuilder.DropForeignKey(
                name: "FK_MonthlyBatches_Companies_CompanyId",
                table: "MonthlyBatches");

            migrationBuilder.DropForeignKey(
                name: "FK_OemPaymentTransfers_Companies_CompanyId",
                table: "OemPaymentTransfers");

            migrationBuilder.DropForeignKey(
                name: "FK_RMATickets_Companies_CompanyId",
                table: "RMATickets");

            migrationBuilder.DropTable(
                name: "Companies");

            migrationBuilder.DropIndex(
                name: "IX_RMATickets_CompanyId_InternalTicketNo",
                table: "RMATickets");

            migrationBuilder.DropIndex(
                name: "IX_OemPaymentTransfers_CompanyId",
                table: "OemPaymentTransfers");

            migrationBuilder.DropIndex(
                name: "IX_MonthlyBatches_CompanyId_BatchId",
                table: "MonthlyBatches");

            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_CompanyId_InvoiceNumber_LineSetIndex",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "CompanyId",
                table: "RMATickets");

            migrationBuilder.DropColumn(
                name: "CompanyId",
                table: "OemPaymentTransfers");

            migrationBuilder.DropColumn(
                name: "CompanyId",
                table: "MonthlyBatches");

            migrationBuilder.DropColumn(
                name: "CompanyId",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "DefaultCompanyId",
                table: "AppUsers");

            migrationBuilder.CreateIndex(
                name: "IX_RMATickets_InternalTicketNo",
                table: "RMATickets",
                column: "InternalTicketNo",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MonthlyBatches_BatchId",
                table: "MonthlyBatches",
                column: "BatchId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_InvoiceNumber_LineSetIndex",
                table: "CarePackBatches",
                columns: new[] { "InvoiceNumber", "LineSetIndex" },
                unique: true);
        }
    }
}
