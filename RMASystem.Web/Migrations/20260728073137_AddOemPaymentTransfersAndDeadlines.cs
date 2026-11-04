using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class AddOemPaymentTransfersAndDeadlines : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<decimal>(
                name: "OemInvoiceAmount",
                table: "CarePackBatches",
                type: "decimal(18,2)",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OemInvoiceCurrency",
                table: "CarePackBatches",
                type: "nvarchar(10)",
                maxLength: 10,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "OemPaymentTransfers",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    TransferReference = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: false),
                    PaymentDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Amount = table.Column<decimal>(type: "decimal(18,2)", nullable: false),
                    Currency = table.Column<string>(type: "nvarchar(10)", maxLength: 10, nullable: false),
                    BankName = table.Column<string>(type: "nvarchar(120)", maxLength: 120, nullable: true),
                    SwiftCode = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: true),
                    FromAccount = table.Column<string>(type: "nvarchar(80)", maxLength: 80, nullable: true),
                    ToAccount = table.Column<string>(type: "nvarchar(80)", maxLength: 80, nullable: true),
                    Notes = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OemPaymentTransfers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OemPaymentAllocations",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    OemPaymentTransferId = table.Column<int>(type: "int", nullable: false),
                    CarePackBatchId = table.Column<int>(type: "int", nullable: false),
                    AllocatedAmount = table.Column<decimal>(type: "decimal(18,2)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OemPaymentAllocations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_OemPaymentAllocations_CarePackBatches_CarePackBatchId",
                        column: x => x.CarePackBatchId,
                        principalTable: "CarePackBatches",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_OemPaymentAllocations_OemPaymentTransfers_OemPaymentTransferId",
                        column: x => x.OemPaymentTransferId,
                        principalTable: "OemPaymentTransfers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_OemPaymentAllocations_CarePackBatchId",
                table: "OemPaymentAllocations",
                column: "CarePackBatchId");

            migrationBuilder.CreateIndex(
                name: "IX_OemPaymentAllocations_OemPaymentTransferId_CarePackBatchId",
                table: "OemPaymentAllocations",
                columns: new[] { "OemPaymentTransferId", "CarePackBatchId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "OemPaymentAllocations");

            migrationBuilder.DropTable(
                name: "OemPaymentTransfers");

            migrationBuilder.DropColumn(
                name: "OemInvoiceAmount",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "OemInvoiceCurrency",
                table: "CarePackBatches");
        }
    }
}
